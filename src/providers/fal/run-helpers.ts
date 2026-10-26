/**
 * Shared helpers for fal.ai commands: input parsing, submit+poll+fetch flow,
 * and media-URL extraction/download from a result payload.
 */

import fs from "node:fs";
import path from "node:path";
import { isRetryableServerStatus } from "../../core/async-poll.js";
import { MultixError, ProviderError } from "../../core/errors.js";
import { downloadToFile } from "../../core/http-client.js";
import { parseJsonInput } from "../../core/json-input.js";
import type { Logger } from "../../core/logger.js";
import { redactUrl } from "../../core/redact.js";
import { detectExtension } from "../../core/stdin-file.js";
import { extFromContentType, extFromUrl } from "../replicate/output.js";
import { type FalClient, HttpError, createFalClient, submitPath } from "./client.js";
import type { FalResultResponse, FalStatusResponse, FalSubmitResponse } from "./types.js";

/** Parse `--input` as inline JSON or `@path/to/file.json`. */
export function parseInputArg(raw: string): Record<string, unknown> {
  return parseJsonInput(raw);
}

export interface SubmitAndWaitOptions {
  model: string;
  input: Record<string, unknown>;
  logger: Logger;
  waitTimeoutMs?: number;
  /** Poll interval override — mainly for tests. Defaults to 3000ms. */
  pollIntervalMs?: number;
}

export interface SubmitAndWaitResult {
  requestId: string;
  result: FalResultResponse;
}

/** True for errors worth retrying while polling: network failures and 5xx responses except 501/505. */
function isTransientError(e: unknown): boolean {
  if (e instanceof HttpError) return isRetryableServerStatus(e.status);
  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("Aborted"));
    });
  });
}

/** Error code of a submit whose outcome is unknown (see {@link submitFalRequest}). */
export const UNKNOWN_REMOTE_STATE = "UNKNOWN_REMOTE_STATE";

/**
 * True when a failed submit may still have queued the job: the connection
 * dropped (status 0), a gateway 5xx answered for a backend that may have
 * accepted it, or fal answered 2xx with a body that could not be read.
 */
function isAmbiguousSubmitFailure(e: unknown): e is HttpError {
  if (!(e instanceof HttpError)) return false;
  return isRetryableServerStatus(e.status) || (e.status >= 200 && e.status < 300);
}

/**
 * POST a job to the fal queue and return its submit response once fal has
 * accepted it (both follow-up URLs checked against the trusted hosts first,
 * so the key is never sent elsewhere). Never retried: a second POST would be
 * a second paid job. When the submit fails in a way that does not prove fal
 * rejected it (see {@link isAmbiguousSubmitFailure}), it is reported as
 * UNKNOWN_REMOTE_STATE rather than as a retryable error, so callers do not
 * resubmit blindly. `onAccepted` runs as soon as fal returned a well-formed
 * request_id, before the URL checks, so the job can be resumed (e.g. from a
 * receipt) even when those checks refuse to poll.
 */
export async function submitFalRequest(
  client: FalClient,
  model: string,
  input: Record<string, unknown>,
  logger: Logger,
  onAccepted?: (submit: FalSubmitResponse) => void,
): Promise<FalSubmitResponse> {
  let submitRes: FalSubmitResponse;
  try {
    submitRes = await client.post<FalSubmitResponse>(submitPath(model), input, logger);
  } catch (e) {
    if (isAmbiguousSubmitFailure(e)) {
      const reason = e.status === 0 ? e.snippet : `HTTP ${e.status}`;
      throw new MultixError(
        `fal submit to ${model} failed before fal confirmed it (${reason}): the request may or may not have been queued. Check https://fal.ai/dashboard/requests before submitting again.`,
        UNKNOWN_REMOTE_STATE,
        { cause: e },
      );
    }
    throw e;
  }
  if (typeof submitRes?.request_id !== "string" || !/^[\w.-]{1,128}$/.test(submitRes.request_id)) {
    throw new MultixError(
      `fal accepted the submit to ${model} but returned no usable request_id: the request may have been queued. Check https://fal.ai/dashboard/requests before submitting again.`,
      UNKNOWN_REMOTE_STATE,
    );
  }
  logger.debug(`request_id: ${submitRes.request_id}`);
  onAccepted?.(submitRes);
  // Refuse both follow-up URLs up front (ProviderError, host only) so the key
  // is never sent to an untrusted host and the error is not wrapped as a poll failure.
  for (const field of ["status_url", "response_url"] as const) {
    const url: unknown = submitRes[field];
    if (typeof url !== "string" || url === "") {
      throw new ProviderError(`fal submit response is missing ${field}`, "fal");
    }
    client.assertTrustedUrl(url);
  }
  return submitRes;
}

export interface WaitForResultOptions {
  client: FalClient;
  model: string;
  submit: FalSubmitResponse;
  logger: Logger;
  waitTimeoutMs?: number;
  /** Poll interval override — mainly for tests. Defaults to 3000ms. */
  pollIntervalMs?: number;
}

/**
 * Poll a submitted request's status_url until COMPLETED (bounded by a real
 * deadline, retrying transient network/5xx errors), then fetch response_url.
 * Uses the URLs fal itself returned from submit rather than reconstructing
 * them, since the queue's status/result URLs are keyed by app id (first two
 * path segments of the model id), not the full endpoint id. Never submits.
 */
export async function waitForFalResult(opts: WaitForResultOptions): Promise<FalResultResponse> {
  const { client, model, submit, logger } = opts;
  const requestId = submit.request_id;
  logger.info("Polling for completion...");

  const waitTimeoutMs = opts.waitTimeoutMs ?? 480_000;
  const intervalMs = opts.pollIntervalMs ?? 3000;
  const deadline = Date.now() + waitTimeoutMs;
  const resumeHint = `Resume with: multix fal status ${model} ${requestId}  or  multix fal result ${model} ${requestId}`;

  let attempt = 0;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for fal request ${requestId} after ${waitTimeoutMs}ms. ${resumeHint}`,
      );
    }

    attempt++;
    let statusRes: FalStatusResponse;
    try {
      statusRes = await client.getAbsolute<FalStatusResponse>(submit.status_url, logger);
    } catch (e) {
      if (isTransientError(e)) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.debug(`attempt ${attempt} — transient error, retrying: ${msg}`);
        await sleep(intervalMs);
        continue;
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to poll status for fal request ${requestId}: ${msg}. ${resumeHint}`);
    }

    logger.debug(`attempt ${attempt} — status: ${statusRes.status}`);
    if (statusRes.status === "COMPLETED") break;
    await sleep(intervalMs);
  }

  try {
    return await client.getAbsolute<FalResultResponse>(submit.response_url, logger);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to fetch result for fal request ${requestId}: ${msg}. ${resumeHint}`);
  }
}

/** Submit a job and wait for its result (see submitFalRequest and waitForFalResult). */
export async function submitAndWait(opts: SubmitAndWaitOptions): Promise<SubmitAndWaitResult> {
  const client = createFalClient();
  const submit = await submitFalRequest(client, opts.model, opts.input, opts.logger);
  const result = await waitForFalResult({ ...opts, client, submit });
  return { requestId: submit.request_id, result };
}

const MEDIA_URL_RE = /^https?:\/\//i;

function isHttpUrl(v: unknown): v is string {
  return typeof v === "string" && MEDIA_URL_RE.test(v);
}

/**
 * A media URL from a fal result, with what the result says about the file:
 * fal's File objects carry `content_type` and `file_name` next to `url`, and
 * those name the format even when the URL has no extension.
 */
export interface FalMediaRef {
  url: string;
  contentType?: string;
  fileName?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** A media ref from a single media-item-shaped value ({ url } or a bare URL string). */
function refOf(item: unknown): FalMediaRef | undefined {
  if (isHttpUrl(item)) return { url: item };
  if (item !== null && typeof item === "object" && "url" in item) {
    const record = item as Record<string, unknown>;
    if (!isHttpUrl(record.url)) return undefined;
    const contentType = str(record.content_type);
    const fileName = str(record.file_name);
    return {
      url: record.url,
      ...(contentType ? { contentType } : {}),
      ...(fileName ? { fileName } : {}),
    };
  }
  return undefined;
}

/** Pull refs from fal's common result shapes: images[], video, image, audio. */
function extractKnownMediaRefs(result: FalResultResponse): FalMediaRef[] {
  const refs: FalMediaRef[] = [];
  const images = result.images;
  if (Array.isArray(images)) {
    for (const img of images) {
      const r = refOf(img);
      if (r) refs.push(r);
    }
  }
  for (const key of ["video", "image", "audio"]) {
    const r = refOf((result as Record<string, unknown>)[key]);
    if (r) refs.push(r);
  }
  return refs;
}

/** Recursively collect every object with an http(s) "url" field from a result. */
function extractMediaRefsGeneric(
  value: unknown,
  acc: FalMediaRef[] = [],
  seen = new Set<unknown>(),
): FalMediaRef[] {
  if (value === null || typeof value !== "object") return acc;
  if (seen.has(value)) return acc;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) extractMediaRefsGeneric(item, acc, seen);
    return acc;
  }

  const ref = refOf(value);
  if (ref) acc.push(ref);
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (key !== "url" && typeof val === "object" && val !== null) {
      extractMediaRefsGeneric(val, acc, seen);
    }
  }
  return acc;
}

/** Recursively collect every string value keyed "url" from a result object. */
export function extractMediaUrlsGeneric(value: unknown): string[] {
  return extractMediaRefsGeneric(value).map((r) => r.url);
}

/**
 * Extract media refs from a fal result. Prefers the well-known
 * `images[].url` / `video.url` / `image.url` / `audio.url` shapes; falls
 * back to a generic recursive scan for any other `url` field only when none
 * of the known fields matched.
 */
export function extractMediaRefs(result: unknown): FalMediaRef[] {
  if (result === null || typeof result !== "object") return [];
  const known = extractKnownMediaRefs(result as FalResultResponse);
  if (known.length > 0) return known;
  return extractMediaRefsGeneric(result);
}

/** URLs of {@link extractMediaRefs}. */
export function extractMediaUrls(result: unknown): string[] {
  return extractMediaRefs(result).map((r) => r.url);
}

/** Formats without a header: magic bytes cannot confirm or contradict them. */
const RAW_AUDIO_EXTS = new Set([".pcm", ".ulaw", ".alaw", ".raw"]);
const AUDIO_EXTS = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".opus",
  ".flac",
  ".aac",
  ".m4a",
  ".aiff",
  ".mp4",
  ".webm",
  ...RAW_AUDIO_EXTS,
]);
/** Audio MIME types fal returns that the shared table does not name. */
const EXTRA_MIME_EXT: Record<string, string> = {
  "audio/opus": ".opus",
  "audio/pcm": ".pcm",
  "audio/l16": ".pcm",
  "audio/basic": ".ulaw",
  "audio/x-flac": ".flac",
  "audio/aiff": ".aiff",
  "audio/x-aiff": ".aiff",
  "audio/webm": ".webm",
};

function extFromMime(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXTRA_MIME_EXT[mime] ?? extFromContentType(mime);
}

function extFromName(name: string | undefined): string | undefined {
  const m = name?.match(/\.([A-Za-z0-9]{1,5})$/);
  return m?.[1] ? `.${m[1].toLowerCase()}` : undefined;
}

/**
 * File extension for downloaded media: the format the bytes themselves show
 * wins (a WAV served as `audio.mp3` is saved as .wav); otherwise what fal
 * declared for the file (`content_type`, then `file_name`), the URL path,
 * then the download's Content-Type header, else `.bin`. A declared raw
 * format (PCM, u-law) is kept, since its bytes carry no signature to check.
 */
export function chooseMediaExt(
  head: Buffer,
  ref: FalMediaRef,
  responseContentType?: string,
): string {
  const declared =
    extFromMime(ref.contentType) ??
    extFromName(ref.fileName) ??
    extFromUrl(ref.url) ??
    extFromMime(responseContentType);
  const sniffed = head.length > 0 ? detectExtension(head) : undefined;
  if (sniffed && sniffed !== ".txt" && !(declared && RAW_AUDIO_EXTS.has(declared))) {
    return sniffed;
  }
  return declared ?? ".bin";
}

/** Why `bytes` are not usable audio, or undefined when they are. */
export function audioProblem(head: Buffer, bytes: number, ext: string): string | undefined {
  if (bytes === 0) return "the file is empty";
  if (head.length > 0 && detectExtension(head) === ".txt") {
    return "the body is text, not audio (an error page or a JSON message)";
  }
  if (!AUDIO_EXTS.has(ext)) return `expected audio but the file is ${ext.slice(1)}`;
  return undefined;
}

function readHead(file: string): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

export interface DownloadMediaOptions {
  /** Refuse files that are not audio (empty, text, another media type). */
  expect?: "audio";
  /** Collects a one-line reason per file that was not saved. */
  problems?: string[];
}

/**
 * Download every media ref (or bare URL) into outDir with a
 * `fal-<request_id>-<n>.<ext>` name, the extension chosen by
 * {@link chooseMediaExt} once the bytes are on disk. Any partially-written
 * file from a failed download is removed, and so is a file that fails the
 * `expect` check.
 */
export async function downloadResultMedia(
  items: Array<string | FalMediaRef>,
  outDir: string,
  requestId: string,
  logger: Logger,
  opts: DownloadMediaOptions = {},
): Promise<string[]> {
  const saved: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const ref = typeof item === "string" ? { url: item } : item;
    // The full id: fal ids are UUIDv7, whose leading characters are shared by
    // every job submitted within about a minute.
    const base = `fal-${requestId.replace(/[^A-Za-z0-9_.-]/g, "_")}-${String(i + 1).padStart(2, "0")}`;
    const staging = path.join(outDir, `${base}.download.part`);
    try {
      const res = await downloadToFile(ref.url, { dest: staging });
      const head = readHead(staging);
      const ext = chooseMediaExt(head, ref, res.contentType);
      const problem = opts.expect === "audio" ? audioProblem(head, res.bytes, ext) : undefined;
      if (problem) {
        fs.rmSync(staging, { force: true });
        opts.problems?.push(`${redactUrl(ref.url)}: ${problem}`);
        logger.warn(`Not audio: ${redactUrl(ref.url)} (${problem})`);
        continue;
      }
      const filepath = path.join(outDir, `${base}${ext}`);
      try {
        fs.renameSync(staging, filepath);
      } catch {
        // Windows refuses to rename over an existing file.
        fs.rmSync(filepath, { force: true });
        fs.renameSync(staging, filepath);
      }
      saved.push(filepath);
      logger.success(`Saved ${filepath}`);
    } catch (e) {
      fs.rmSync(staging, { force: true });
      const msg = e instanceof Error ? e.message : String(e);
      opts.problems?.push(`${redactUrl(ref.url)}: ${msg}`);
      logger.warn(`Download failed for ${redactUrl(ref.url)}: ${msg}`);
    }
  }
  return saved;
}
