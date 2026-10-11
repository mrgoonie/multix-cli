/**
 * Node-only HeyGen helpers for the CLI: env-based client construction, local
 * file uploads, the shared wait/download flow, and output formatting. Network
 * logic lives in the runtime-neutral client/jobs modules.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { PollTimeoutError } from "../../core/async-poll.js";
import { resolveKey } from "../../core/env-loader.js";
import { ConfigError, HttpError, ValidationError } from "../../core/errors.js";
import { downloadFile } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { getOutputDir } from "../../core/output-dir.js";
import { redactUrl } from "../../core/redact.js";
import { maybeDownloadThumb } from "../../core/video-thumb.js";
import { HeygenClient } from "./client.js";
import { HeygenJobFailedError } from "./heygen-errors.js";
import { type HeygenJobState, assertJobSucceeded, resumeCommand, waitForJob } from "./jobs.js";
import {
  ASSET_MIME_BY_EXT,
  DEFAULT_HEYGEN_BASE_URL,
  HEYGEN_API_SETTINGS_URL,
  type HeygenJobKind,
  LIMITS,
} from "./models.js";
import { classifyMediaRef } from "./request-builders.js";
import type { HeygenAssetInput } from "./types.js";

export function requireHeygenKey(): string {
  const key = resolveKey("HEYGEN_API_KEY")?.trim();
  if (!key) {
    throw new ConfigError(
      `HEYGEN_API_KEY is not set. Create an API key at ${HEYGEN_API_SETTINGS_URL} (API usage is billed separately from HeyGen web plans).`,
    );
  }
  return key;
}

/** Build a client from env. `HEYGEN_BASE_URL` exists for tests and proxies. */
export function createHeygenClientFromEnv(): HeygenClient {
  return new HeygenClient({
    apiKey: requireHeygenKey(),
    baseUrl: resolveKey("HEYGEN_BASE_URL") ?? DEFAULT_HEYGEN_BASE_URL,
  });
}

/** Read a local file and upload it via POST /v3/assets. */
export async function uploadLocalFile(
  client: HeygenClient,
  filePath: string,
  logger: Logger,
): Promise<HeygenAssetInput> {
  const abs = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new ValidationError(
      `File not found: ${filePath}. Use an https:// URL, asset:<asset_id>, or an existing file.`,
    );
  }
  if (!stat.isFile()) throw new ValidationError(`Not a file: ${filePath}`);
  const ext = path.extname(abs).slice(1).toLowerCase();
  const mimeType = ASSET_MIME_BY_EXT[ext];
  if (!mimeType) {
    throw new ValidationError(
      `Unsupported file type ".${ext}" for HeyGen upload. Supported: ${Object.keys(ASSET_MIME_BY_EXT).join(", ")}`,
    );
  }
  if (stat.size > LIMITS.assetUploadMaxBytes) {
    throw new ValidationError(
      `${filePath} is ${(stat.size / 1024 / 1024).toFixed(1)} MB; HeyGen asset upload accepts at most 32 MB. Host it at a public https:// URL instead.`,
    );
  }
  logger.info(`Uploading ${path.basename(abs)} to HeyGen assets...`);
  const res = await client.uploadAsset({
    data: new Uint8Array(fs.readFileSync(abs)),
    filename: path.basename(abs),
    mimeType,
  });
  logger.debug(`Uploaded asset ${res.asset_id} (${res.mime_type}, ${res.size_bytes} bytes)`);
  return { type: "asset_id", asset_id: res.asset_id };
}

/** Resolve `https://…`, `asset:<id>`, or a local path into an AssetInput. */
export async function resolveMediaInput(
  client: HeygenClient,
  value: string,
  logger: Logger,
): Promise<HeygenAssetInput> {
  const ref = classifyMediaRef(value);
  if (ref.kind === "url") return { type: "url", url: ref.url };
  if (ref.kind === "asset") return { type: "asset_id", asset_id: ref.assetId };
  return uploadLocalFile(client, ref.path, logger);
}

export async function resolveMediaInputs(
  client: HeygenClient,
  values: string[] | undefined,
  logger: Logger,
): Promise<HeygenAssetInput[]> {
  const out: HeygenAssetInput[] = [];
  for (const v of values ?? []) out.push(await resolveMediaInput(client, v, logger));
  return out;
}

/** Commander collector for repeatable options. */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function parsePositiveInt(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new ValidationError(`${flag} must be a positive integer`);
  return n;
}

// ── Wait / download flow ──────────────────────────────────────────────────

export interface WaitFlowOptions {
  async?: boolean;
  wait?: boolean;
  waitTimeout?: string;
  pollInterval?: string;
  download?: boolean;
  output?: string;
  thumb?: boolean;
  captions?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export const DEFAULT_WAIT_TIMEOUT_MS = 1_800_000;

/** Adds the shared async/wait/download flags to a generation command. */
export function addWaitOptions(cmd: Command, defaultTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Command {
  return cmd
    .option("--async", "Return job IDs and a resume command immediately (no polling)")
    .option("--wait-timeout <ms>", "Max time to wait for completion", String(defaultTimeoutMs))
    .option("--poll-interval <ms>", "Initial poll interval (backs off to 30s)", "5000")
    .option("--no-download", "Do not download outputs; print output URLs instead")
    .option("--output <path>", "Output file (or directory when several outputs are produced)")
    .option("--captions", "Also download the caption/subtitle file when one is available")
    .option("--no-thumb", "Skip downloading the video thumbnail")
    .option("--json", "Print a JSON summary instead of human-readable output")
    .option("-v, --verbose", "Verbose logging");
}

const OUTPUT_EXTS = new Set(["mp4", "webm", "mov", "mp3", "wav", "m4a", "aac", "srt", "vtt"]);

export function inferExtension(url: string, fallback: string): string {
  try {
    const ext = path.extname(new URL(url).pathname).slice(1).toLowerCase();
    return OUTPUT_EXTS.has(ext) ? ext : fallback;
  } catch {
    return fallback;
  }
}

function safeSlug(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "out"
  );
}

/**
 * Download one signed output URL to `dest`, removing partial files and
 * explaining expired-URL failures without echoing the signed query string.
 */
export async function downloadOutput(
  url: string | undefined,
  dest: string,
  resumeHint: string,
): Promise<string> {
  if (!url) {
    throw new ValidationError(`HeyGen reported success but returned no output URL. ${resumeHint}`);
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new ValidationError(`HeyGen returned an invalid output URL (${redactUrl(url)})`);
  }
  try {
    await downloadFile(url, dest, 600_000);
  } catch (e) {
    fs.rmSync(dest, { force: true });
    const status = e instanceof HttpError ? e.status : 0;
    const expired = status === 403 || status === 404 || status === 410;
    const reason = e instanceof Error ? e.message : String(e);
    throw new ValidationError(
      `Failed to download HeyGen output from ${redactUrl(url)}: ${reason}.${expired ? " The signed URL may have expired." : ""} ${resumeHint}`,
    );
  }
  return dest;
}

export function defaultOutputPath(state: HeygenJobState, ext: string): string {
  const lang = state.outputLanguage ? `-${safeSlug(state.outputLanguage)}` : "";
  return path.join(getOutputDir(), `heygen-${state.kind}${lang}-${safeSlug(state.id)}.${ext}`);
}

/** Resolve the destination for one of `count` outputs. `--output` is a dir when count > 1. */
function outputPathFor(
  state: HeygenJobState,
  ext: string,
  output: string | undefined,
  count: number,
) {
  if (!output) return defaultOutputPath(state, ext);
  if (count > 1) {
    const dir = path.resolve(output);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, path.basename(defaultOutputPath(state, ext)));
  }
  return path.resolve(output);
}

/** Secret-free summary of a job state (signed URLs reduced to origin+path). */
export function summarizeState(state: HeygenJobState): Record<string, unknown> {
  const out: Record<string, unknown> = {
    kind: state.kind,
    id: state.id,
    status: state.status,
  };
  if (state.sessionId) out.session_id = state.sessionId;
  if (state.sessionStatus) out.session_status = state.sessionStatus;
  if (state.videoId) out.video_id = state.videoId;
  if (state.progress !== undefined) out.progress = state.progress;
  if (state.outputLanguage) out.output_language = state.outputLanguage;
  if (state.outputUrl) out.output_url = redactUrl(state.outputUrl);
  if (state.failureCode) out.failure_code = state.failureCode;
  if (state.failureMessage) out.failure_message = state.failureMessage;
  return out;
}

export interface FinishedJob {
  state: HeygenJobState;
  files: string[];
}

/** Download outputs (or print URLs) for completed states. */
export async function deliverOutputs(
  states: HeygenJobState[],
  opts: WaitFlowOptions,
  logger: Logger,
): Promise<FinishedJob[]> {
  const results: FinishedJob[] = [];
  for (const state of states) {
    const hint = `Refresh with: ${resumeCommand(state.kind, state.id)}`;
    if (opts.download === false) {
      if (!state.outputUrl)
        throw new ValidationError(`No output URL for ${state.kind} ${state.id}. ${hint}`);
      if (!opts.json) console.log(state.outputUrl);
      results.push({ state, files: [] });
      continue;
    }
    const ext = inferExtension(state.outputUrl ?? "", "mp4");
    const dest = outputPathFor(state, ext, opts.output, states.length);
    await downloadOutput(state.outputUrl, dest, hint);
    logger.success(`Saved ${dest}`);
    const files = [dest];

    if (opts.captions && state.captionUrl) {
      const capExt = inferExtension(state.captionUrl, "srt");
      const capDest = path.join(
        path.dirname(dest),
        `${path.basename(dest, path.extname(dest))}.${capExt}`,
      );
      await downloadOutput(state.captionUrl, capDest, hint);
      logger.success(`Saved ${capDest}`);
      files.push(capDest);
    } else if (opts.captions) {
      logger.warn(`No caption file available for ${state.kind} ${state.id}`);
    }

    if (state.kind === "video" || state.kind === "agent") {
      const thumb = await maybeDownloadThumb(state.raw, dest, {
        skip: opts.thumb === false,
        logger,
      });
      if (thumb) files.push(thumb);
    }
    results.push({ state, files });
  }
  return results;
}

/** Print the final summary for finished jobs. */
export function printFinished(results: FinishedJob[], opts: WaitFlowOptions): void {
  if (opts.json) {
    const jobs = results.map((r) => ({ ...summarizeState(r.state), files: r.files }));
    console.log(JSON.stringify(jobs.length === 1 ? jobs[0] : jobs, null, 2));
    return;
  }
  for (const r of results) {
    for (const f of r.files) console.log(`Saved: ${f}`);
  }
}

/** Print IDs + resume commands for `--async`. */
export function printSubmitted(kind: HeygenJobKind, ids: string[], opts: WaitFlowOptions): void {
  if (opts.json) {
    const jobs = ids.map((id) => ({
      kind,
      id,
      status: "submitted",
      resume: resumeCommand(kind, id),
    }));
    console.log(JSON.stringify(jobs.length === 1 ? jobs[0] : jobs, null, 2));
    return;
  }
  for (const id of ids) {
    console.log(`Submitted ${kind} job: ${id}`);
    console.log(`  Resume with: ${resumeCommand(kind, id)}`);
  }
}

/**
 * Shared post-submit flow: `--async` prints IDs; otherwise wait for every job,
 * fail non-zero if any job failed, then download outputs.
 */
export async function completeJobs(
  client: HeygenClient,
  kind: HeygenJobKind,
  ids: string[],
  opts: WaitFlowOptions,
  logger: Logger,
): Promise<FinishedJob[]> {
  if (ids.length === 0) throw new ValidationError("HeyGen returned no job IDs");
  if (opts.async) {
    printSubmitted(kind, ids, opts);
    return [];
  }
  const timeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout", DEFAULT_WAIT_TIMEOUT_MS);
  const intervalMs = parsePositiveInt(opts.pollInterval, "--poll-interval", 5000);
  logger.info(
    `Waiting for ${ids.length > 1 ? `${ids.length} ${kind} jobs` : `${kind} ${ids[0]}`}...`,
  );

  const settled = await Promise.allSettled(
    ids.map((id) =>
      waitForJob(client, kind, id, {
        timeoutMs,
        intervalMs,
        maxIntervalMs: Math.max(intervalMs, 30_000),
        resumeHint: `Resume with: ${resumeCommand(kind, id)}`,
        onPoll: (s, attempt) =>
          logger.debug(
            `${kind} ${id} poll #${attempt}: ${s.status}${s.videoId ? ` (video ${s.videoId})` : ""}`,
          ),
      }),
    ),
  );

  const states: HeygenJobState[] = [];
  const failures: string[] = [];
  for (const [i, r] of settled.entries()) {
    if (r.status === "fulfilled") {
      if (r.value.succeeded) states.push(r.value);
      else {
        try {
          assertJobSucceeded(r.value);
        } catch (e) {
          failures.push(e instanceof Error ? e.message : String(e));
        }
      }
    } else {
      const err = r.reason;
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(err instanceof PollTimeoutError ? msg : `${kind} ${ids[i]}: ${msg}`);
    }
  }

  const finished = states.length > 0 ? await deliverOutputs(states, opts, logger) : [];
  printFinished(finished, opts);
  if (failures.length > 0) {
    throw new HeygenJobFailedError(failures.join("\n"));
  }
  return finished;
}
