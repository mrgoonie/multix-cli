/**
 * Shared helpers for fal.ai commands: input parsing, submit+poll+fetch flow,
 * and media-URL extraction/download from a result payload.
 */

import fs from "node:fs";
import path from "node:path";
import { ValidationError } from "../../core/errors.js";
import { downloadFile } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { HttpError, createFalClient, submitPath } from "./client.js";
import type { FalResultResponse, FalStatusResponse, FalSubmitResponse } from "./types.js";

/** Parse `--input` as inline JSON or `@path/to/file.json`. */
export function parseInputArg(raw: string): Record<string, unknown> {
  const text = raw.startsWith("@") ? fs.readFileSync(raw.slice(1), "utf8") : raw;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("input must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ValidationError(`Invalid --input JSON: ${msg}`);
  }
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

/** True for errors worth retrying while polling: network failures and 5xx responses. */
function isTransientError(e: unknown): boolean {
  if (e instanceof HttpError) return e.status === 0 || e.status >= 500;
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

/**
 * Submit a job, poll its status_url until COMPLETED (bounded by a real
 * deadline, retrying transient network/5xx errors), then fetch response_url.
 * Uses the URLs fal itself returns from submit rather than reconstructing
 * them, since the queue's status/result URLs are keyed by app id (first two
 * path segments of the model id), not the full endpoint id.
 */
export async function submitAndWait(opts: SubmitAndWaitOptions): Promise<SubmitAndWaitResult> {
  const { model, input, logger } = opts;
  const client = createFalClient();

  const submitRes = await client.post<FalSubmitResponse>(submitPath(model), input, logger);
  const requestId = submitRes.request_id;
  logger.debug(`request_id: ${requestId}`);
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
      statusRes = await client.getAbsolute<FalStatusResponse>(submitRes.status_url, logger);
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
    const result = await client.getAbsolute<FalResultResponse>(submitRes.response_url, logger);
    return { requestId, result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to fetch result for fal request ${requestId}: ${msg}. ${resumeHint}`);
  }
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

/**
 * Download every extracted media URL into outDir with a `fal-<reqIdPrefix>-<n>.<ext>`
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
    const filename = `fal-${requestId.slice(0, 8)}-${String(i + 1).padStart(2, "0")}${ext}`;
    const filepath = path.join(outDir, filename);
    try {
      await downloadFile(url, filepath);
      saved.push(filepath);
      logger.success(`Saved ${filepath}`);
    } catch (e) {
      fs.rmSync(filepath, { force: true });
      logger.warn(`Download failed for ${url}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return saved;
}
