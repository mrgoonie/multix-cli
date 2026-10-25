/**
 * fal.ai storage upload client (runtime-neutral, no node:* imports).
 *
 * Same protocol as the official `@fal-ai/client` storage client (v1.10.1,
 * src/storage.ts), reimplemented here so the CLI needs no extra dependency:
 * - POST https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3
 *   with `{ content_type, file_name }` and `Authorization: Key <FAL_KEY>`
 *   returns `{ upload_url, file_url }`;
 * - the bytes are PUT to `upload_url` WITHOUT the key (it is a signed URL);
 * - files over 90 MB use `initiate-multipart`: 10 MB parts are PUT to
 *   `<upload_url path>/<n>?<query>`, then `<path>/complete?<query>` gets the
 *   part etags.
 * The key goes only to {@link FAL_REST_URL}. `upload_url` is signed: it is
 * never logged, and errors name its host only. `file_url` is readable by
 * anyone who has it.
 */

import { HttpError, ProviderError, ValidationError } from "../../core/errors.js";
import { type FetchLike, fetchJson, httpErrorFromResponse } from "../../core/fetch-json.js";
import type { Logger } from "../../core/logger.js";

/** fal's REST API origin (fal-js `getRestApiUrl()`); the only host that gets the key on upload. */
export const FAL_REST_URL = "https://rest.fal.ai";
/** Files above this size use multipart upload, as in fal-js. */
export const FAL_MULTIPART_THRESHOLD = 90 * 1024 * 1024;
const PART_SIZE = 10 * 1024 * 1024;
const DEFAULT_ATTEMPTS = 3;

/** fal-js lifecycle presets for `expiresIn`, in seconds (`never` sends nothing). */
const EXPIRATION_PRESETS: Record<string, number | undefined> = {
  never: undefined,
  "1h": 3600,
  "1d": 86400,
  "7d": 604800,
  "30d": 2592000,
  "1y": 31536000,
};

/** Accepted `--expires-in` values: a preset name or a whole number of seconds. */
export const FAL_EXPIRY_PRESETS = Object.keys(EXPIRATION_PRESETS);

/**
 * Seconds for an `--expires-in` value, or undefined for `never`. Throws on
 * anything that is neither a preset nor a positive whole number of seconds.
 */
export function parseFalExpiry(raw: string): number | undefined {
  const value = raw.trim().toLowerCase();
  if (value in EXPIRATION_PRESETS) return EXPIRATION_PRESETS[value];
  if (/^\d+$/.test(value) && Number(value) > 0) return Number(value);
  throw new ValidationError(
    `Invalid --expires-in "${raw}": use ${FAL_EXPIRY_PRESETS.join(", ")} or a number of seconds`,
  );
}

export interface FalUploadOptions {
  apiKey: string;
  /** File contents; a lazily read Blob (e.g. `fs.openAsBlob`) keeps large files out of memory. */
  data: Blob;
  fileName: string;
  contentType: string;
  /** Ask fal to delete the object after this many seconds. Omitted: fal's default retention. */
  expiresInSeconds?: number;
  /** Tries per HTTP step for network errors and retryable 5xx/429 (default 3). */
  attempts?: number;
  /** Defaults to globalThis.fetch, resolved at call time so tests can stub it. */
  fetch?: FetchLike;
  /** Overrides {@link FAL_REST_URL}; tests only. */
  restUrl?: string;
  logger?: Logger;
  /** Per-request timeout for the PUT of one body or part (default 30 min). */
  uploadTimeoutMs?: number;
}

interface InitiateResponse {
  upload_url?: unknown;
  file_url?: unknown;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "an invalid URL";
  }
}

/** Throws unless `value` is an https URL (the signed upload URL or the public file URL). */
function requireHttpsUrl(value: unknown, field: string): string {
  if (typeof value === "string") {
    try {
      if (new URL(value).protocol === "https:") return value;
    } catch {}
  }
  throw new ProviderError(`fal storage returned no valid https ${field}`, "fal");
}

/** Network failures (status 0), 408, 429 and 5xx except 501/505 are worth another try. */
function isRetryable(e: unknown): boolean {
  if (!(e instanceof HttpError)) return false;
  const s = e.status;
  return s === 0 || s === 408 || s === 429 || (s >= 500 && s !== 501 && s !== 505);
}

async function withRetries<T>(
  attempts: number,
  label: string,
  logger: Logger | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts || !isRetryable(e)) throw e;
      const delay = Math.min(500 * 2 ** (attempt - 1), 4000);
      logger?.debug(`${label} failed (attempt ${attempt}/${attempts}), retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Send a body to a signed storage URL without the fal key. The URL is never
 * put in an error message (only its host): its query string is the credential.
 */
async function sendUnkeyed(
  doFetch: FetchLike,
  url: string,
  init: { method: "PUT" | "POST"; body: Blob | string; contentType?: string },
  timeoutMs: number,
): Promise<Response> {
  const safeUrl = `https://${hostOf(url)}/[signed upload URL]`;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: init.method,
      body: init.body,
      headers: init.contentType ? { "Content-Type": init.contentType } : {},
      signal: AbortSignal.timeout(timeoutMs),
      // A signed URL that redirects elsewhere is not followed with the body.
      redirect: "error",
    } as RequestInit);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new HttpError(0, `Upload request failed: ${msg}`, safeUrl);
  }
  if (!response.ok) throw await httpErrorFromResponse(response, safeUrl);
  return response;
}

async function initiate(
  opts: FalUploadOptions,
  doFetch: FetchLike,
  kind: "initiate" | "initiate-multipart",
): Promise<{ uploadUrl: string; fileUrl: string }> {
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
  const res = await withRetries(
    opts.attempts ?? DEFAULT_ATTEMPTS,
    "upload initiate",
    opts.logger,
    () =>
      fetchJson<InitiateResponse>({
        url: `${base}/storage/upload/${kind}?storage_type=fal-cdn-v3`,
        method: "POST",
        headers,
        body: { content_type: opts.contentType, file_name: opts.fileName },
        fetch: doFetch,
      }),
  );
  return {
    uploadUrl: requireHttpsUrl(res.upload_url, "upload_url"),
    fileUrl: requireHttpsUrl(res.file_url, "file_url"),
  };
}

/**
 * Upload one file to fal storage and return its public `file_url`. Each HTTP
 * step is retried on network errors and retryable statuses; the local data is
 * only read, never modified.
 */
export async function uploadToFalStorage(opts: FalUploadOptions): Promise<string> {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const timeoutMs = opts.uploadTimeoutMs ?? 30 * 60_000;
  const { data, contentType, logger } = opts;

  if (data.size <= FAL_MULTIPART_THRESHOLD) {
    const { uploadUrl, fileUrl } = await initiate(opts, doFetch, "initiate");
    await withRetries(attempts, "upload", logger, () =>
      sendUnkeyed(doFetch, uploadUrl, { method: "PUT", body: data, contentType }, timeoutMs),
    );
    return fileUrl;
  }

  const { uploadUrl, fileUrl } = await initiate(opts, doFetch, "initiate-multipart");
  const parsed = new URL(uploadUrl);
  const partBase = `${parsed.origin}${parsed.pathname}`;
  const parts: Array<{ partNumber: unknown; etag: unknown }> = [];
  const count = Math.ceil(data.size / PART_SIZE);
  for (let i = 0; i < count; i++) {
    const partNumber = i + 1;
    const chunk = data.slice(i * PART_SIZE, Math.min((i + 1) * PART_SIZE, data.size));
    logger?.debug(`Uploading part ${partNumber}/${count}`);
    const response = await withRetries(attempts, `upload part ${partNumber}`, logger, () =>
      sendUnkeyed(
        doFetch,
        `${partBase}/${partNumber}${parsed.search}`,
        // Parts go without a Content-Type, as in fal-js.
        { method: "PUT", body: chunk },
        timeoutMs,
      ),
    );
    const part = (await response.json().catch(() => ({}))) as {
      partNumber?: unknown;
      etag?: unknown;
    };
    parts.push({ partNumber: part.partNumber ?? partNumber, etag: part.etag });
  }
  await withRetries(attempts, "upload complete", logger, () =>
    sendUnkeyed(
      doFetch,
      `${partBase}/complete${parsed.search}`,
      { method: "POST", body: JSON.stringify({ parts }), contentType: "application/json" },
      timeoutMs,
    ),
  );
  return fileUrl;
}
