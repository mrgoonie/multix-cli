/**
 * Run one multix job: fresh temp directory, download inputs, execFile the CLI
 * (argv only, never a shell) with only the caller's keys in its env, collect
 * the files it wrote to out/, upload them to the caller's R2 bucket, and
 * report truncated, redacted stdout/stderr. The directory is always removed.
 *
 * One deadline (`spec.timeoutMs`, at most 30 minutes) covers the whole job:
 * downloads, the CLI and uploads. The CLI gets what is left minus a reserve
 * for uploads, so a finished job still has time to deliver its files before
 * the Durable Object gives up on it.
 *
 * The result also reports how long each phase took (`timings`) and, when the
 * CLI recorded its run in the job's history file, a redacted summary of that
 * record (`run`) for the usage ledger.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputError, downloadInputs } from "./job-inputs.mjs";
import { collectOutputs, uploadOutputs } from "./job-outputs.mjs";
import { readRunSummary } from "./job-run-summary.mjs";

export const MAX_TEXT_BYTES = 16 * 1024;
const MAX_CLI_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_JOB_TIMEOUT_MS = 30 * 60_000;
/** Time kept back from the CLI for uploads: a quarter of the budget, at most 5 minutes. */
const MAX_UPLOAD_RESERVE_MS = 5 * 60_000;
/** Env names a job may pass to the CLI: provider credentials and Cloudflare ids only. */
const KEY_NAME_RE =
  /^(?:[A-Z][A-Z0-9]*_API_(?:KEY|TOKEN)|FAL_KEY|CLOUDFLARE_(?:ACCOUNT_ID|AI_GATEWAY_ID))$/;
const NO_STORAGE_NOTE =
  "R2 storage is not configured: configure R2 in /dashboard to receive output files. Provider URLs printed by the CLI are returned unchanged.";

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
        validKeyPrefix(spec.upload.keyPrefix) &&
        spec.upload.r2 &&
        typeof spec.upload.r2 === "object"));
  if (!ok) throw new SpecError("Invalid job");
  return spec;
}

/** `<directory>/<16 hex account hash>/<job id>`; the directory is checked again here because it came from account settings. */
function validKeyPrefix(prefix) {
  if (prefix.length > 512) return false;
  const segments = prefix.split("/");
  if (segments.length < 3) return false;
  const [hash, jobId] = segments.slice(-2);
  return (
    /^[0-9a-f]{16}$/.test(hash) &&
    /^[0-9a-f-]{36}$/.test(jobId) &&
    segments.slice(0, -2).every((s) => /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..")
  );
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
      { ...options, maxBuffer: MAX_CLI_BUFFER_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        const exitCode = error ? (typeof error.code === "number" ? error.code : null) : 0;
        resolve({
          exitCode,
          killed: Boolean(error?.killed),
          overflow: error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

/**
 * @param {object} spec validated job spec
 * @param {{ signal?: AbortSignal, bin?: string, fetch?: typeof fetch, get?: Function, basePath?: string }} [options]
 *   `signal` cancels the job; `fetch` (uploads) and `get` (downloads) are injected in tests.
 */
export async function runJob(spec, options = {}) {
  const secrets = secretsOf(spec);
  const budget = Math.min(spec.timeoutMs, MAX_JOB_TIMEOUT_MS);
  const startedAt = Date.now();
  const deadline = AbortSignal.timeout(budget);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const dir = await mkdtemp(join(tmpdir(), "multix-job-"));
  const result = { status: "failed", exitCode: null, stdout: "", stderrTail: "", outputs: [] };
  if (!spec.upload) result.note = NO_STORAGE_NOTE;
  // Phases that never ran stay at 0; a phase that threw still reports its time.
  const timings = { inputsMs: 0, cliMs: 0, uploadMs: 0 };
  const timed = async (phase, work) => {
    const started = performance.now();
    try {
      return await work();
    } finally {
      timings[phase] = Math.round(performance.now() - started);
    }
  };
  const stopped = () => {
    if (options.signal?.aborted) return "canceled";
    return deadline.aborted ? "timed_out" : undefined;
  };
  try {
    const outDir = join(dir, "out");
    await mkdir(join(dir, "in"));
    await mkdir(outDir);
    await timed("inputsMs", () => downloadInputs(dir, spec.inputs, { signal, get: options.get }));
    const reserve = Math.min(MAX_UPLOAD_RESERVE_MS, Math.floor(budget / 4));
    const cliTimeout = Math.max(1, budget - (Date.now() - startedAt) - reserve);
    // Outside out/, so the CLI's record of the run is never uploaded as an output.
    const historyFile = join(dir, "history.jsonl");
    const run = await timed("cliMs", () =>
      runCli(options.bin ?? "multix", spec.argv, {
        cwd: dir,
        env: {
          PATH: options.basePath ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: dir,
          MULTIX_DISABLE_HOME_ENV: "1",
          MULTIX_HISTORY_FILE: historyFile,
          MULTIX_OUTPUT_DIR: outDir,
          NO_COLOR: "1",
          ...spec.env,
        },
        timeout: cliTimeout,
        killSignal: "SIGTERM",
        signal,
      }),
    );
    const summary = await readRunSummary(historyFile, (text) => redact(text, secrets));
    if (summary) result.run = summary;
    result.exitCode = run.exitCode;
    // Redact first: a key cut in half by truncation could not be matched any more.
    result.stdout = head(redact(run.stdout, secrets));
    result.stderrTail = tail(redact(run.stderr, secrets));
    if (run.overflow) {
      result.status = "failed";
      result.error = "The CLI wrote more than 16 MB to stdout or stderr and was stopped";
    } else if (stopped()) result.status = stopped();
    else if (run.killed) result.status = "timed_out";
    else result.status = run.exitCode === 0 ? "succeeded" : "failed";

    result.outputs = await timed("uploadMs", async () => {
      const files = await collectOutputs(outDir);
      return spec.upload
        ? await uploadOutputs(files, spec.upload, { fetch: options.fetch, signal })
        : files.map(({ name, bytes }) => ({ name, url: null, bytes }));
    });
  } catch (error) {
    result.status = stopped() ?? "failed";
    const known = error instanceof InputError || error?.name === "R2UploadError";
    const message =
      result.status === "timed_out"
        ? "The job did not finish within its time limit"
        : known
          ? error.message
          : "The job failed inside the container";
    result.error = redact(message, secrets);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  result.timings = timings;
  return result;
}
