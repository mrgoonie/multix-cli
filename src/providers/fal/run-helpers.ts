/**
 * Shared helpers for fal.ai commands: input parsing, submit+poll+fetch flow,
 * and generic media-URL extraction/download from an arbitrary result payload.
 */

import fs from "node:fs";
import path from "node:path";
import { ValidationError } from "../../core/errors.js";
import { downloadFile } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { PollFailedError, PollTimeoutError, poll } from "../leonardo/poll.js";
import { createFalClient, resultPath, statusPath, submitPath } from "./client.js";
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

/** Submit a job, poll status to completion, then fetch and return the result. */
export async function submitAndWait(opts: SubmitAndWaitOptions): Promise<SubmitAndWaitResult> {
  const { model, input, logger } = opts;
  const client = createFalClient();

  const submitRes = await client.post<FalSubmitResponse>(submitPath(model), input, logger);
  const requestId = submitRes.request_id;
  logger.debug(`request_id: ${requestId}`);
  logger.info("Polling for completion...");

  const waitTimeout = opts.waitTimeoutMs ?? 480_000;
  const intervalMs = opts.pollIntervalMs ?? 3000;

  try {
    await poll<FalStatusResponse>({
      fetch: () => client.get<FalStatusResponse>(statusPath(model, requestId), logger),
      done: (v) => v.status === "COMPLETED",
      intervalMs,
      maxAttempts: Math.max(1, Math.ceil(waitTimeout / intervalMs)),
      onTick: (attempt, v) => logger.debug(`attempt ${attempt} — status: ${v.status}`),
    });
  } catch (e) {
    if (e instanceof PollTimeoutError) {
      throw new Error(`Timed out waiting for fal request ${requestId}`);
    }
    if (e instanceof PollFailedError) {
      throw new Error(`fal request ${requestId} failed: ${JSON.stringify(e.value)}`);
    }
    throw e;
  }

  const result = await client.get<FalResultResponse>(resultPath(model, requestId), logger);
  return { requestId, result };
}

const MEDIA_URL_RE = /^https?:\/\//i;

/** Recursively collect every string value keyed "url" (or inside a "url" field) from a result object. */
export function extractMediaUrls(
  value: unknown,
  acc: string[] = [],
  seen = new Set<unknown>(),
): string[] {
  if (value === null || typeof value !== "object") return acc;
  if (seen.has(value)) return acc;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) extractMediaUrls(item, acc, seen);
    return acc;
  }

  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (key === "url" && typeof val === "string" && MEDIA_URL_RE.test(val)) {
      acc.push(val);
    } else if (typeof val === "object" && val !== null) {
      extractMediaUrls(val, acc, seen);
    }
  }
  return acc;
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

/** Download every extracted media URL into outDir with a `fal-<reqIdPrefix>-<n>.<ext>` name. */
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
      logger.warn(`Download failed for ${url}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return saved;
}
