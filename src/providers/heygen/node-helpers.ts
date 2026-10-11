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
import { downloadToFile } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { getOutputDir } from "../../core/output-dir.js";
import { redactUrl } from "../../core/redact.js";
import { detectThumbUrl, maybeDownloadThumb } from "../../core/video-thumb.js";
import { HeygenClient } from "./client.js";
import { HeygenJobFailedError } from "./heygen-errors.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  type HeygenJobState,
  assertJobSucceeded,
  resumeCommand,
  staggerOffsetMs,
  waitForJob,
} from "./jobs.js";
import {
  ASSET_MIME_BY_EXT,
  DEFAULT_HEYGEN_BASE_URL,
  HEYGEN_API_SETTINGS_URL,
  type HeygenJobKind,
  LIMITS,
} from "./models.js";
import { checkBaseUrl, classifyMediaRef, isHttpsUrl } from "./request-builders.js";
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

/**
 * Build a client from env. `HEYGEN_BASE_URL` exists for tests and proxies; it
 * must be https:// (plain http:// only for loopback hosts) so the key is never
 * sent in cleartext.
 */
export function createHeygenClientFromEnv(): HeygenClient {
  const apiKey = requireHeygenKey();
  const override = resolveKey("HEYGEN_BASE_URL")?.trim();
  return new HeygenClient({
    apiKey,
    baseUrl: override ? checkBaseUrl(override, "HEYGEN_BASE_URL") : DEFAULT_HEYGEN_BASE_URL,
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
  /** Deliver the burned-in caption render (`captioned_video_url`). */
  burnCaptions?: boolean;
}

export const DEFAULT_WAIT_TIMEOUT_MS = 1_800_000;

/** Adds the shared async/wait/download flags to a generation command. */
export function addWaitOptions(cmd: Command, defaultTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Command {
  return cmd
    .option("--async", "Return job IDs and a resume command immediately (no polling)")
    .option("--wait-timeout <ms>", "Max time to wait for completion", String(defaultTimeoutMs))
    .option(
      "--poll-interval <ms>",
      "Initial poll interval (backs off to 30s)",
      String(DEFAULT_POLL_INTERVAL_MS),
    )
    .option("--no-download", "Do not download outputs; print output URLs instead")
    .option(
      "--output <path>",
      "Output file or directory. A path ending in / or \\, an existing directory, or a path without an extension is a directory; with several outputs, a media file name gets a per-language suffix (dub.mp4 -> dub-Spanish.mp4)",
    )
    .option("--captions", "Also download the caption/subtitle file when one is available")
    .option("--no-thumb", "Skip downloading the video thumbnail")
    .option("--json", "Print a JSON summary instead of human-readable output")
    .option("-v, --verbose", "Verbose logging");
}

const VIDEO_EXTS = new Set(["mp4", "webm", "mov"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac"]);
/** Extensions that make a multi-output `--output` a name template. */
const MEDIA_EXTS = new Set([...VIDEO_EXTS, ...AUDIO_EXTS]);
const OUTPUT_EXTS = new Set([...MEDIA_EXTS, "srt", "vtt"]);

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

/** Redirect validator: every hop, and the final response URL, must be https://. */
function requireHttps(url: string): void {
  if (!isHttpsUrl(url)) throw new HttpError(0, "redirected to a non-https URL", url);
}

/**
 * Stream `url` to `dest` with the shared validated-redirect downloader, so a
 * redirect to plain http:// is refused before any body is written.
 */
function downloadHttps(url: string, dest: string, timeoutMs: number): Promise<unknown> {
  return downloadToFile(url, { dest, timeoutMs, validateUrl: requireHttps });
}

/**
 * Download one signed output URL to `dest`. The file is written to a sibling
 * temp file and renamed into place, so a failed download never touches an
 * existing file at `dest`. Expired-URL failures are explained without echoing
 * the signed query string.
 */
export async function downloadOutput(
  url: string | undefined,
  dest: string,
  resumeHint: string,
): Promise<string> {
  if (!url) {
    throw new ValidationError(`HeyGen reported success but returned no output URL. ${resumeHint}`);
  }
  if (!isHttpsUrl(url)) {
    throw new ValidationError(
      `Refusing to download HeyGen output from a non-https URL (${redactUrl(url)})`,
    );
  }
  try {
    await downloadHttps(url, dest, 600_000);
  } catch (e) {
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

function statOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

/** `--output` names a directory: trailing separator, existing directory, or no extension. */
function isDirectoryOutput(output: string, target: string): boolean {
  if (/[\\/]$/.test(output)) return true;
  const stat = statOrUndefined(target);
  if (stat) return stat.isDirectory();
  return path.extname(target) === "";
}

/**
 * Swap a video extension for the real audio one (and vice versa), so an
 * audio-only translation saved via `--output dub.mp4` is not named `.mp4`.
 */
function withMediaExt(file: string, ext: string): string {
  const given = path.extname(file).slice(1).toLowerCase();
  const mismatch =
    (VIDEO_EXTS.has(given) && AUDIO_EXTS.has(ext)) ||
    (AUDIO_EXTS.has(given) && VIDEO_EXTS.has(ext));
  return mismatch ? `${file.slice(0, -(given.length + 1))}.${ext}` : file;
}

/**
 * Resolve the destination for one of `count` outputs. A directory `--output`
 * (trailing separator, existing directory, or no extension) receives the
 * default file names. Otherwise a single output is saved to that file, and
 * with several outputs a media file name is a template (`dub.mp4` ->
 * `dub-Spanish.mp4`, suffixed with the output language or job ID).
 */
function outputPathFor(
  state: HeygenJobState,
  ext: string,
  output: string | undefined,
  count: number,
): string {
  if (!output) return defaultOutputPath(state, ext);
  const target = path.resolve(output);
  const givenExt = path.extname(target);
  const isTemplate = count > 1 && MEDIA_EXTS.has(givenExt.slice(1).toLowerCase());
  if (isDirectoryOutput(output, target) || (count > 1 && !isTemplate)) {
    fs.mkdirSync(target, { recursive: true });
    return path.join(target, path.basename(defaultOutputPath(state, ext)));
  }
  if (!isTemplate) return withMediaExt(target, ext);
  const base = path.basename(target, givenExt);
  const suffix = safeSlug(state.outputLanguage ?? state.id);
  return withMediaExt(path.join(path.dirname(target), `${base}-${suffix}${givenExt}`), ext);
}

/**
 * Make `dest` unique within one batch (compared case-insensitively, since
 * Windows and macOS file systems usually are): on a repeat, append the job ID,
 * then a counter. Two jobs never write the same file.
 */
function claimPath(dest: string, state: HeygenJobState, used: Set<string>): string {
  const ext = path.extname(dest);
  const stem = dest.slice(0, dest.length - ext.length);
  let candidate = dest;
  for (let n = 1; used.has(candidate.toLowerCase()); n++) {
    const id = safeSlug(state.id);
    candidate = n === 1 ? `${stem}-${id}${ext}` : `${stem}-${id}-${n}${ext}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Sibling caption path for `dest`; never the video file itself. */
function captionPathFor(dest: string, capExt: string): string {
  const stem = path.join(path.dirname(dest), path.basename(dest, path.extname(dest)));
  const capDest = `${stem}.${capExt}`;
  return capDest.toLowerCase() === dest.toLowerCase() ? `${stem}.captions.${capExt}` : capDest;
}

/** https-only downloader for thumbnails (same redirect policy as outputs). */
const downloadThumbHttpsOnly = (url: string, dest: string) => downloadHttps(url, dest, 120_000);

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
  if (state.captionedVideoUrl) out.captioned_video_url = redactUrl(state.captionedVideoUrl);
  if (state.failureCode) out.failure_code = state.failureCode;
  if (state.failureMessage) out.failure_message = state.failureMessage;
  return out;
}

export interface FinishedJob {
  state: HeygenJobState;
  files: string[];
  /**
   * Usable (unredacted) URLs, set only for `--no-download`, whose whole purpose
   * is to hand the caller a fetchable URL.
   */
  urls?: { output_url: string; caption_url?: string };
}

export interface DeliveryResult {
  finished: FinishedJob[];
  /** One message per job whose delivery failed; other jobs are still delivered. */
  failures: string[];
}

async function deliverOne(
  state: HeygenJobState,
  opts: WaitFlowOptions,
  count: number,
  logger: Logger,
  files: string[],
  usedPaths: Set<string>,
): Promise<FinishedJob> {
  const hint = `Refresh with: ${resumeCommand(state.kind, state.id, opts)}`;
  if (opts.download === false) {
    if (!state.outputUrl) {
      throw new ValidationError(`No output URL for ${state.kind} ${state.id}. ${hint}`);
    }
    if (!opts.json) console.log(state.outputUrl);
    const urls = {
      output_url: state.outputUrl,
      ...(state.captionUrl ? { caption_url: state.captionUrl } : {}),
    };
    return { state, files, urls };
  }
  const ext = inferExtension(state.outputUrl ?? "", state.outputIsAudio ? "mp3" : "mp4");
  const dest = claimPath(outputPathFor(state, ext, opts.output, count), state, usedPaths);
  await downloadOutput(state.outputUrl, dest, hint);
  logger.success(`Saved ${dest}`);
  files.push(dest);

  if (opts.captions && state.captionUrl) {
    const capExt = inferExtension(state.captionUrl, "srt");
    const capDest = claimPath(captionPathFor(dest, capExt), state, usedPaths);
    await downloadOutput(state.captionUrl, capDest, hint);
    logger.success(`Saved ${capDest}`);
    files.push(capDest);
  } else if (opts.captions) {
    logger.warn(`No caption file available for ${state.kind} ${state.id}`);
  }

  if ((state.kind === "video" || state.kind === "agent") && opts.thumb !== false) {
    const thumbUrl = detectThumbUrl(state.raw);
    if (thumbUrl && !isHttpsUrl(thumbUrl)) {
      logger.warn(`Skipping thumbnail from a non-https URL (${redactUrl(thumbUrl)})`);
    } else {
      const thumb = await maybeDownloadThumb(state.raw, dest, {
        logger,
        download: downloadThumbHttpsOnly,
      });
      if (thumb) files.push(thumb);
    }
  }
  return { state, files };
}

/**
 * Download outputs (or print URLs) for completed states. A failure on one job
 * is recorded and the remaining jobs are still delivered.
 */
export async function deliverOutputs(
  states: HeygenJobState[],
  opts: WaitFlowOptions,
  logger: Logger,
): Promise<DeliveryResult> {
  const finished: FinishedJob[] = [];
  const failures: string[] = [];
  const usedPaths = new Set<string>();
  for (const state of states) {
    const files: string[] = [];
    try {
      finished.push(await deliverOne(state, opts, states.length, logger, files, usedPaths));
    } catch (e) {
      failures.push(`${state.kind} ${state.id}: ${e instanceof Error ? e.message : String(e)}`);
      if (files.length > 0) finished.push({ state, files });
    }
  }
  return { finished, failures };
}

/** Print the final summary for finished jobs. */
export function printFinished(results: FinishedJob[], opts: WaitFlowOptions): void {
  if (opts.json) {
    const jobs = results.map((r) => ({ ...summarizeState(r.state), ...r.urls, files: r.files }));
    if (jobs.length > 0) console.log(JSON.stringify(jobs.length === 1 ? jobs[0] : jobs, null, 2));
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
      resume: resumeCommand(kind, id, opts),
    }));
    console.log(JSON.stringify(jobs.length === 1 ? jobs[0] : jobs, null, 2));
    return;
  }
  for (const id of ids) {
    console.log(`Submitted ${kind} job: ${id}`);
    console.log(`  Resume with: ${resumeCommand(kind, id, opts)}`);
  }
}

/**
 * Shared post-submit flow: `--async` prints IDs; otherwise wait for every job,
 * deliver every success, print the summary, and fail non-zero if any job or
 * download failed.
 */
export async function completeJobs(
  client: HeygenClient,
  kind: HeygenJobKind,
  ids: string[],
  opts: WaitFlowOptions,
  logger: Logger,
): Promise<FinishedJob[]> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string" || !id)) {
    throw new ValidationError(`HeyGen returned no usable ${kind} job ID`);
  }
  if (opts.async) {
    printSubmitted(kind, ids, opts);
    return [];
  }
  const timeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout", DEFAULT_WAIT_TIMEOUT_MS);
  const intervalMs = parsePositiveInt(
    opts.pollInterval,
    "--poll-interval",
    DEFAULT_POLL_INTERVAL_MS,
  );
  logger.info(
    `Waiting for ${ids.length > 1 ? `${ids.length} ${kind} jobs` : `${kind} ${ids[0]}`}...`,
  );

  const settled = await Promise.allSettled(
    ids.map((id, index) =>
      waitForJob(client, kind, id, {
        timeoutMs,
        intervalMs,
        startDelayMs: staggerOffsetMs(index, intervalMs),
        maxIntervalMs: Math.max(intervalMs, 30_000),
        burnCaptions: opts.burnCaptions,
        resumeHint: `Resume with: ${resumeCommand(kind, id, opts)}`,
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

  const delivery =
    states.length > 0 ? await deliverOutputs(states, opts, logger) : { finished: [], failures: [] };
  failures.push(...delivery.failures);
  printFinished(delivery.finished, opts);
  if (failures.length > 0) {
    const total = ids.length;
    const ok = total - failures.length;
    const header =
      total > 1 ? `${ok} of ${total} ${kind} jobs delivered; ${failures.length} failed:\n` : "";
    throw new HeygenJobFailedError(`${header}${failures.join("\n")}`);
  }
  return delivery.finished;
}
