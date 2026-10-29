/**
 * Shared helpers for fal.ai commands: input parsing, submit+poll+fetch flow,
 * and media-URL extraction/download from a result payload.
 */

import fs from "node:fs";
import path from "node:path";
import {
  PollTimeoutError,
  isRetryableServerStatus,
  isTransientHttpError,
} from "../../core/async-poll.js";
import { audioExtFromMime } from "../../core/audio-kind.js";
import { MultixError, ProviderError } from "../../core/errors.js";
import { downloadFile } from "../../core/http-client.js";
import { parseJsonInput } from "../../core/json-input.js";
import type { Logger } from "../../core/logger.js";
import { redactUrl } from "../../core/redact.js";
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

/** Longest a single status or result request may take; fal's client default. */
const MAX_REQUEST_TIMEOUT_MS = 120_000;
/** Shortest timeout a request is started with, even right at the wait deadline. */
const MIN_REQUEST_TIMEOUT_MS = 10_000;

/** A request's timeout: the time left before the deadline, within the bounds above. */
function requestTimeoutMs(deadline: number): number {
  return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, deadline - Date.now()));
}

/** Wait before retrying a transient failure: Retry-After, at least the poll interval, never past the deadline. */
function retryDelayMs(error: unknown, intervalMs: number, deadline: number): number {
  const retryAfterMs = error instanceof HttpError ? error.retryAfterMs : undefined;
  const delay = Math.max(retryAfterMs ?? 0, intervalMs);
  return Math.min(delay, Math.max(1, deadline - Date.now()));
}

/**
 * Poll a submitted request's status_url until COMPLETED (bounded by a real
 * deadline, retrying transient network/408/429/5xx errors), then fetch
 * response_url, retrying the same errors until the deadline. Each request's
 * timeout is bounded by the time left (see requestTimeoutMs).
 * Uses the URLs fal itself returned from submit rather than reconstructing
 * them, since the queue's status/result URLs are keyed by app id (first two
 * path segments of the model id), not the full endpoint id. Never submits.
 * A failed poll or fetch is rethrown with the request id and resume hint, and
 * the original error as `cause` so classifyError keeps its class and Retry-After.
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
  let lastError: unknown;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const last = lastError instanceof Error ? ` Last error: ${lastError.message}.` : "";
      throw new PollTimeoutError(
        `Timed out waiting for fal request ${requestId} after ${waitTimeoutMs}ms.${last} ${resumeHint}`,
      );
    }

    attempt++;
    let statusRes: FalStatusResponse;
    try {
      statusRes = await client.requestAbsolute<FalStatusResponse>(submit.status_url, {
        logger,
        timeoutMs: requestTimeoutMs(deadline),
      });
      lastError = undefined;
    } catch (e) {
      // The job is already submitted: a network error, 408, 429 or retryable 5xx is waited out
      // (honouring Retry-After, never past the deadline) rather than ending the run.
      if (isTransientHttpError(e)) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        logger.debug(`attempt ${attempt} — transient error, retrying: ${msg}`);
        await sleep(retryDelayMs(e, intervalMs, deadline));
        continue;
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to poll status for fal request ${requestId}: ${msg}. ${resumeHint}`, {
        cause: e,
      });
    }

    logger.debug(`attempt ${attempt} — status: ${statusRes.status}`);
    if (statusRes.status === "COMPLETED") break;
    await sleep(intervalMs);
  }

  // The job is finished and billed: a transient failure fetching its result is retried while
  // the deadline allows; the last one is rethrown with its own class (e.g. RATE_LIMITED).
  for (;;) {
    try {
      return await client.requestAbsolute<FalResultResponse>(submit.response_url, {
        logger,
        timeoutMs: requestTimeoutMs(deadline),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isTransientHttpError(e) && deadline - Date.now() > 0) {
        logger.debug(`result fetch — transient error, retrying: ${msg}`);
        await sleep(retryDelayMs(e, intervalMs, deadline));
        continue;
      }
      throw new Error(
        `Failed to fetch result for fal request ${requestId}: ${msg}. ${resumeHint}`,
        {
          cause: e,
        },
      );
    }
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

/** Extract "url" from a single media-item-shaped value ({ url } or a bare URL string). */
function urlOf(item: unknown): string | undefined {
  if (isHttpUrl(item)) return item;
  if (item !== null && typeof item === "object" && "url" in item) {
    const u = (item as Record<string, unknown>).url;
    if (isHttpUrl(u)) return u;
  }
  return undefined;
}

/** Pull URLs from fal's common result shapes: images[], video, image, audio. */
function extractKnownMediaUrls(result: FalResultResponse): string[] {
  const urls: string[] = [];
  const images = result.images;
  if (Array.isArray(images)) {
    for (const img of images) {
      const u = urlOf(img);
      if (u) urls.push(u);
    }
  }
  for (const key of ["video", "image", "audio"]) {
    const u = urlOf((result as Record<string, unknown>)[key]);
    if (u) urls.push(u);
  }
  return urls;
}

/** Recursively collect every string value keyed "url" (or inside a "url" field) from a result object. */
export function extractMediaUrlsGeneric(
  value: unknown,
  acc: string[] = [],
  seen = new Set<unknown>(),
): string[] {
  if (value === null || typeof value !== "object") return acc;
  if (seen.has(value)) return acc;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) extractMediaUrlsGeneric(item, acc, seen);
    return acc;
  }

  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (key === "url" && isHttpUrl(val)) {
      acc.push(val);
    } else if (typeof val === "object" && val !== null) {
      extractMediaUrlsGeneric(val, acc, seen);
    }
  }
  return acc;
}

/**
 * Extract media URLs from a fal result. Prefers the well-known
 * `images[].url` / `video.url` / `image.url` / `audio.url` shapes; falls
 * back to a generic recursive scan for any other `url` field only when none
 * of the known fields matched.
 */
export function extractMediaUrls(result: unknown): string[] {
  if (result === null || typeof result !== "object") return [];
  const known = extractKnownMediaUrls(result as FalResultResponse);
  if (known.length > 0) return known;
  return extractMediaUrlsGeneric(result);
}

function extFromUrl(url: string, fallback = ".bin"): string {
  try {
    const u = new URL(url);
    const e = path.extname(u.pathname);
    return e.length > 0 ? e : fallback;
  } catch {
    return fallback;
  }
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "model/gltf-binary": ".glb",
};

/** Extension for a response Content-Type, for URLs that have none. */
function extFromContentType(contentType: string | undefined): string | undefined {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  const known = EXT_BY_MIME[mime];
  if (known) return known;
  const audio = audioExtFromMime(mime);
  return audio ? `.${audio}` : undefined;
}

/**
 * Download every extracted media URL into outDir with a `fal-<request_id>-<n>.<ext>`
 * name. Any partially-written file from a failed download is removed.
 */
export async function downloadResultMedia(
  urls: string[],
  outDir: string,
  requestId: string,
  logger: Logger,
): Promise<string[]> {
  const saved: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    if (!url) continue;
    const ext = extFromUrl(url);
    // The full id: fal ids are UUIDv7, whose leading characters are shared by
    // every job submitted within about a minute.
    const filename = `fal-${requestId.replace(/[^A-Za-z0-9_.-]/g, "_")}-${String(i + 1).padStart(2, "0")}${ext}`;
    let filepath = path.join(outDir, filename);
    try {
      const contentType = await downloadFile(url, filepath);
      // A URL without an extension: name the file by the served Content-Type.
      const typed = extFromUrl(url, "") === "" ? extFromContentType(contentType) : undefined;
      if (typed) {
        const renamed = filepath.replace(/\.bin$/, typed);
        try {
          fs.renameSync(filepath, renamed);
          filepath = renamed;
        } catch {
          // The download succeeded; keep it under its .bin name.
        }
      }
      saved.push(filepath);
      logger.success(`Saved ${filepath}`);
    } catch (e) {
      fs.rmSync(filepath, { force: true });
      logger.warn(`Download failed for ${redactUrl(url)}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return saved;
}
