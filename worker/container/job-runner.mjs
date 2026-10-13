/**
 * Run one multix job: fresh temp directory, download inputs, execFile the CLI
 * (argv only, never a shell) with only the caller's keys in its env, collect
 * the files it wrote to out/, upload them to the caller's R2 bucket, and
 * report truncated, redacted stdout/stderr. The directory is always removed.
 */

import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { InputError, downloadInputs } from "./job-inputs.mjs";
import { createR2Uploader, safeOutputName } from "./r2-upload.mjs";

export const MAX_TEXT_BYTES = 16 * 1024;
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_OUTPUT_FILES = 50;
const MAX_JOB_TIMEOUT_MS = 30 * 60_000;
/** Env names a job may pass to the CLI: provider credentials and Cloudflare ids only. */
const KEY_NAME_RE =
  /^(?:[A-Z][A-Z0-9]*_API_(?:KEY|TOKEN)|FAL_KEY|CLOUDFLARE_(?:ACCOUNT_ID|AI_GATEWAY_ID))$/;
const NO_STORAGE_NOTE =
  "R2 storage is not configured: configure R2 in /dashboard to receive output files. Provider URLs printed by the CLI are returned unchanged.";

const CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt",
  ".glb": "model/gltf-binary",
};

export class SpecError extends Error {}

/** Check the POST body shape; the Worker already validated the content. */
export function validateSpec(spec) {
  const ok =
    spec &&
    typeof spec === "object" &&
    typeof spec.jobId === "string" &&
    /^[0-9a-f-]{36}$/.test(spec.jobId) &&
    Array.isArray(spec.argv) &&
    spec.argv.length > 0 &&
    spec.argv.every((a) => typeof a === "string" && !a.includes("\0")) &&
    spec.env &&
    typeof spec.env === "object" &&
    Object.entries(spec.env).every(([k, v]) => KEY_NAME_RE.test(k) && typeof v === "string") &&
    Array.isArray(spec.inputs) &&
    spec.inputs.every((i) => i && typeof i.url === "string" && typeof i.path === "string") &&
    Number.isInteger(spec.timeoutMs) &&
    spec.timeoutMs > 0 &&
    (spec.upload === undefined ||
      (spec.upload &&
        typeof spec.upload.keyPrefix === "string" &&
        /^multix\/[0-9a-f]{16}\/[0-9a-f-]{36}$/.test(spec.upload.keyPrefix) &&
        spec.upload.r2 &&
        typeof spec.upload.r2 === "object"));
  if (!ok) throw new SpecError("Invalid job");
  return spec;
}

export function redact(text, secrets) {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
}

function head(text) {
  return text.length > MAX_TEXT_BYTES ? `${text.slice(0, MAX_TEXT_BYTES)}\n…[truncated]` : text;
}

function tail(text) {
  return text.length > MAX_TEXT_BYTES ? `…[truncated]\n${text.slice(-MAX_TEXT_BYTES)}` : text;
}

function secretsOf(spec) {
  const values = Object.values(spec.env);
  if (spec.upload) values.push(spec.upload.r2.secretAccessKey, spec.upload.r2.accessKeyId);
  return values
    .filter((v) => typeof v === "string" && v.length >= 8)
    .sort((a, b) => b.length - a.length);
}

function runCli(bin, argv, options) {
  return new Promise((resolve) => {
    execFile(
      bin,
      argv,
      { ...options, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const exitCode = error ? (typeof error.code === "number" ? error.code : null) : 0;
        resolve({
          exitCode,
          killed: Boolean(error?.killed),
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

/** Regular files under out/ (recursively), with safe, unique names. Symlinks are skipped. */
async function collectOutputs(outDir) {
  const found = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push(full);
    }
  };
  await walk(outDir);
  const used = new Set();
  const outputs = [];
  for (const file of found.sort().slice(0, MAX_OUTPUT_FILES)) {
    const base = safeOutputName(file);
    if (!base) continue;
    let name = base;
    for (let i = 1; used.has(name); i++) name = `${i}-${base}`;
    used.add(name);
    outputs.push({ file, name, bytes: (await lstat(file)).size });
  }
  return outputs;
}

async function uploadOutputs(files, upload, fetchImpl) {
  const r2 = createR2Uploader(upload.r2, { fetch: fetchImpl });
  const outputs = [];
  for (const { file, name, bytes } of files) {
    if (bytes > MAX_UPLOAD_BYTES) {
      outputs.push({ name, url: null, bytes });
      continue;
    }
    const type = CONTENT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
    const url = await r2.put(`${upload.keyPrefix}/${name}`, await readFile(file), type);
    outputs.push({ name, url, bytes });
  }
  return outputs;
}

/**
 * @param {object} spec validated job spec
 * @param {{ signal?: AbortSignal, bin?: string, fetch?: typeof fetch, basePath?: string }} [options]
 */
export async function runJob(spec, options = {}) {
  const secrets = secretsOf(spec);
  const dir = await mkdtemp(join(tmpdir(), "multix-job-"));
  const result = { status: "failed", exitCode: null, stdout: "", stderrTail: "", outputs: [] };
  if (!spec.upload) result.note = NO_STORAGE_NOTE;
  try {
    const outDir = join(dir, "out");
    await mkdir(join(dir, "in"));
    await mkdir(outDir);
    await downloadInputs(dir, spec.inputs, { signal: options.signal, fetch: options.fetch });
    const run = await runCli(options.bin ?? "multix", spec.argv, {
      cwd: dir,
      env: {
        PATH: options.basePath ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: dir,
        MULTIX_DISABLE_HOME_ENV: "1",
        MULTIX_OUTPUT_DIR: outDir,
        NO_COLOR: "1",
        ...spec.env,
      },
      timeout: Math.min(spec.timeoutMs, MAX_JOB_TIMEOUT_MS),
      killSignal: "SIGTERM",
      signal: options.signal,
    });
    result.exitCode = run.exitCode;
    result.stdout = redact(head(run.stdout), secrets);
    result.stderrTail = redact(tail(run.stderr), secrets);
    if (options.signal?.aborted) result.status = "canceled";
    else if (run.killed) result.status = "timed_out";
    else result.status = run.exitCode === 0 ? "succeeded" : "failed";

    const files = await collectOutputs(outDir);
    result.outputs = spec.upload
      ? await uploadOutputs(files, spec.upload, options.fetch)
      : files.map(({ name, bytes }) => ({ name, url: null, bytes }));
  } catch (error) {
    if (options.signal?.aborted) result.status = "canceled";
    else result.status = "failed";
    const known = error instanceof InputError || error?.name === "R2UploadError";
    result.error = redact(known ? error.message : "The job failed inside the container", secrets);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return result;
}
