/**
 * fal.ai storage upload client — runtime-neutral (no node:* imports): the
 * caller passes the file as a Blob (Node's `fs.openAsBlob` reads it lazily,
 * so a large video is never buffered whole), the key, and optionally fetch.
 *
 * Protocol, as implemented by the official client (`@fal-ai/client`
 * storage.ts, `createStorageClient().upload`):
 * 1. POST {rest}/storage/upload/initiate?storage_type=fal-cdn-v3 with
 *    `Authorization: Key <FAL_KEY>` and `{content_type, file_name}`; the
 *    answer is `{upload_url, file_url}`.
 * 2. PUT the bytes to `upload_url` (a signed URL: no key is sent there).
 * Files over 90 MB use `initiate-multipart` instead: 10 MB parts are PUT to
 * `{upload_url path}/{n}{query}` (each answers `{partNumber, etag}`), then
 * POST `{upload_url path}/complete{query}` with the part list.
 * An optional `X-Fal-Object-Lifecycle` header asks fal to expire the object.
 */

import { isRetryableServerStatus } from "../../core/async-poll.js";
import { HttpError, ProviderError, ValidationError } from "../../core/errors.js";
import { type FetchLike, fetchJson } from "../../core/fetch-json.js";
import type { Logger } from "../../core/logger.js";

/** fal's REST host for storage. The key is sent only here, never to upload URLs. */
export const FAL_REST_URL = "https://rest.fal.ai";
/** Same threshold and part size as the official client. */
export const FAL_MULTIPART_THRESHOLD = 90 * 1024 * 1024;
export const FAL_PART_SIZE = 10 * 1024 * 1024;

/** Named lifetimes accepted by `--expires-in`, as in the official client. */
const EXPIRATION_SECONDS: Record<string, number | undefined> = {
  never: undefined,
  "1h": 3600,
  "1d": 86400,
  "7d": 604800,
  "30d": 2592000,
  "1y": 31536000,
};

/**
 * Parse an `--expires-in` value: a named lifetime (1h, 1d, 7d, 30d, 1y,
 * never) or a whole number of seconds. `never` returns undefined (no header).
 */
export function parseExpiresIn(raw: string): number | undefined {
  const value = raw.trim().toLowerCase();
  if (value in EXPIRATION_SECONDS) return EXPIRATION_SECONDS[value];
  if (/^\d+$/.test(value) && Number(value) > 0) return Number(value);
  throw new ValidationError(
    `Invalid --expires-in "${raw}": use 1h, 1d, 7d, 30d, 1y, never, or a number of seconds`,
  );
}

export interface FalUploadOptions {
  file: Blob;
  fileName: string;
  contentType: string;
  apiKey: string;
  /** Defaults to {@link FAL_REST_URL}. */
  restUrl?: string;
  /** Object lifetime in seconds requested from fal; omitted means fal's default. */
  expiresInSeconds?: number;
  /** Attempts per HTTP call for network failures and retryable 5xx (default 3). */
  attempts?: number;
  /** Multipart threshold and part size; default to the official client's 90 MB / 10 MB. */
  multipartThresholdBytes?: number;
  partSizeBytes?: number;
  /** Delay before retry n (1-based), default 1s, 2s, 4s... */
  backoffMs?: (attempt: number) => number;
  logger?: Logger;
  /** Defaults to globalThis.fetch, resolved at call time. */
  fetch?: FetchLike;
}

interface InitiateResponse {
  upload_url?: unknown;
  file_url?: unknown;
}

function isTransient(e: unknown): boolean {
  return e instanceof HttpError && (e.status === 0 || isRetryableServerStatus(e.status));
}

async function withRetries<T>(
  what: string,
  opts: FalUploadOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const backoff = opts.backoffMs ?? ((n: number) => 1000 * 2 ** (n - 1));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts || !isTransient(e)) throw e;
      opts.logger?.warn(`${what} failed (attempt ${attempt}/${attempts}), retrying...`);
      await new Promise((resolve) => setTimeout(resolve, backoff(attempt)));
    }
  }
}

/** A URL the bytes may go to: https only (the signed upload URL carries the auth). */
function requireHttpsUrl(value: unknown, field: string): URL {
  let url: URL | undefined;
  try {
    url = typeof value === "string" ? new URL(value) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== "https:") {
    throw new ProviderError(`fal storage response has no https ${field}`, "fal");
  }
  return url;
}

/** Send a request without credentials; throws HttpError (status 0 for network failures). */
async function sendUnkeyed(
  url: string,
  init: RequestInit,
  doFetch: FetchLike,
  label: string,
): Promise<Response> {
  let response: Response;
  try {
    // Signed upload URLs must not be followed elsewhere: a redirect is an error.
    response = await doFetch(url, { ...init, redirect: "error" });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new HttpError(0, `${label} failed: ${msg}`, url, undefined, { cause });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new HttpError(response.status, text.slice(0, 300) || response.statusText, url);
  }
  return response;
}

async function initiate(
  kind: "initiate" | "initiate-multipart",
  opts: FalUploadOptions,
  doFetch: FetchLike,
): Promise<{ uploadUrl: URL; fileUrl: string }> {
  const base = (opts.restUrl ?? FAL_REST_URL).replace(/\/$/, "");
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Key ${opts.apiKey}`,
  };
  if (opts.expiresInSeconds !== undefined) {
    headers["X-Fal-Object-Lifecycle"] = JSON.stringify({
      expiration_duration_seconds: opts.expiresInSeconds,
    });
  }
  const res = await withRetries(`fal storage ${kind}`, opts, () =>
    fetchJson<InitiateResponse>({
      url: `${base}/storage/upload/${kind}?storage_type=fal-cdn-v3`,
      method: "POST",
      headers,
      body: { content_type: opts.contentType, file_name: opts.fileName },
      fetch: doFetch,
    }),
  );
  const uploadUrl = requireHttpsUrl(res.upload_url, "upload_url");
  const fileUrl = requireHttpsUrl(res.file_url, "file_url").toString();
  return { uploadUrl, fileUrl };
}

async function uploadMultipart(opts: FalUploadOptions, doFetch: FetchLike): Promise<string> {
  const { uploadUrl, fileUrl } = await initiate("initiate-multipart", opts, doFetch);
  const prefix = `${uploadUrl.origin}${uploadUrl.pathname}`;
  const parts: Array<{ partNumber: number; etag: string }> = [];
  const partSize = opts.partSizeBytes ?? FAL_PART_SIZE;
  const total = Math.ceil(opts.file.size / partSize);
  for (let i = 0; i < total; i++) {
    const partNumber = i + 1;
    const chunk = opts.file.slice(i * partSize, Math.min((i + 1) * partSize, opts.file.size));
    const res = await withRetries(`fal storage part ${partNumber}/${total}`, opts, async () => {
      const response = await sendUnkeyed(
        `${prefix}/${partNumber}${uploadUrl.search}`,
        { method: "PUT", body: chunk },
        doFetch,
        `Upload of part ${partNumber}`,
      );
      return (await response.json()) as { partNumber?: unknown; etag?: unknown };
    });
    if (typeof res.etag !== "string") {
      throw new ProviderError(`fal storage part ${partNumber} response has no etag`, "fal");
    }
    parts.push({ partNumber: Number(res.partNumber ?? partNumber), etag: res.etag });
    opts.logger?.debug(`uploaded part ${partNumber}/${total}`);
  }
  await withRetries("fal storage complete", opts, () =>
    sendUnkeyed(
      `${prefix}/complete${uploadUrl.search}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
      },
      doFetch,
      "Completing the upload",
    ),
  );
  return fileUrl;
}

/**
 * Upload a file to fal storage and return its hosted `file_url`. The key goes
 * only to the REST initiate call; bytes go to the signed upload URL without
 * it, and redirects there are refused. Network failures and retryable 5xx are
 * retried (3 attempts by default); the local file is only read.
 */
export async function uploadToFalStorage(opts: FalUploadOptions): Promise<string> {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  if (opts.file.size > (opts.multipartThresholdBytes ?? FAL_MULTIPART_THRESHOLD)) {
    return uploadMultipart(opts, doFetch);
  }

  const { uploadUrl, fileUrl } = await initiate("initiate", opts, doFetch);
  await withRetries("fal storage upload", opts, () =>
    sendUnkeyed(
      uploadUrl.toString(),
      { method: "PUT", body: opts.file, headers: { "content-type": opts.contentType } },
      doFetch,
      "Upload",
    ),
  );
  return fileUrl;
}
