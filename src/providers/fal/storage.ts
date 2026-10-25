/**
 * fal.ai storage upload — runtime-neutral (no node:* imports).
 *
 * Mirrors the flow of the official `@fal-ai/client` StorageClient (v1.x):
 * 1. POST https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3
 *    with `Authorization: Key …` and `{ content_type, file_name }`
 *    -> `{ upload_url, file_url }`.
 * 2. PUT the bytes to `upload_url` (a pre-signed URL: no auth header).
 * Files above 90 MB use the multipart variant (`initiate-multipart`, 10 MB
 * parts PUT to `<upload_url path>/<n>`, then POST `<path>/complete` with the
 * part etags), as the official client does.
 *
 * The key goes only to the fixed fal REST origin; upload URLs never get it.
 * `file_url` is a public CDN link: anyone holding it can read the file, and
 * fal decides how long it is kept.
 */

import { isTransientHttpError } from "../../core/async-poll.js";
import { HttpError, ProviderError } from "../../core/errors.js";
import { toFetchError } from "../../core/fetch-error.js";
import { type FetchLike, fetchJson, httpErrorFromResponse } from "../../core/fetch-json.js";

export const FAL_REST_URL = "https://rest.fal.ai";
export const FAL_MULTIPART_THRESHOLD_BYTES = 90 * 1024 * 1024;
export const FAL_PART_BYTES = 10 * 1024 * 1024;
const INITIATE_TIMEOUT_MS = 60_000;
const DEFAULT_PUT_TIMEOUT_MS = 600_000;
const DEFAULT_ATTEMPTS = 3;

export interface FalUploadOptions {
  apiKey: string;
  file: Blob;
  fileName: string;
  contentType: string;
  fetch?: FetchLike;
  /** Attempts per request on network errors, 408, 429 and retryable 5xx. Default 3. */
  attempts?: number;
  /** Per PUT request (one part for multipart). Default 10 minutes. */
  putTimeoutMs?: number;
  /** Backoff between attempts; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Progress line per part or attempt; never receives URLs. */
  onProgress?: (msg: string) => void;
}

interface InitiateResponse {
  upload_url?: unknown;
  file_url?: unknown;
}

interface PartResponse {
  partNumber?: unknown;
  etag?: unknown;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function requireHttpsUrl(value: unknown, field: string): URL {
  let url: URL | undefined;
  try {
    url = typeof value === "string" ? new URL(value) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== "https:") {
    throw new ProviderError(`fal storage returned a missing or non-https ${field}`, "fal");
  }
  return url;
}

async function withRetries<T>(
  opts: FalUploadOptions,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts || !isTransientHttpError(e)) throw e;
      const wait = Math.min((e as HttpError).retryAfterMs ?? 1000 * 2 ** (attempt - 1), 30_000);
      opts.onProgress?.(`${label} failed (${(e as HttpError).status || "network"}), retrying...`);
      await sleep(wait);
    }
  }
}

async function initiate(
  opts: FalUploadOptions,
  multipart: boolean,
): Promise<{ uploadUrl: URL; fileUrl: URL }> {
  const kind = multipart ? "initiate-multipart" : "initiate";
  const res = await withRetries(opts, "Upload initiate", () =>
    fetchJson<InitiateResponse>({
      url: `${FAL_REST_URL}/storage/upload/${kind}?storage_type=fal-cdn-v3`,
      method: "POST",
      headers: { accept: "application/json", authorization: `Key ${opts.apiKey}` },
      body: { content_type: opts.contentType, file_name: opts.fileName },
      timeoutMs: INITIATE_TIMEOUT_MS,
      fetch: opts.fetch,
    }),
  );
  return {
    uploadUrl: requireHttpsUrl(res?.upload_url, "upload_url"),
    fileUrl: requireHttpsUrl(res?.file_url, "file_url"),
  };
}

/** One unauthenticated request to a pre-signed URL; throws HttpError on failure. */
async function sendUnauthenticated(
  opts: FalUploadOptions,
  url: string,
  init: { method: "PUT" | "POST"; body: Blob | string; contentType: string },
): Promise<Response> {
  const doFetch: FetchLike = opts.fetch ?? ((input, i) => globalThis.fetch(input, i));
  let response: Response;
  try {
    response = await doFetch(url, {
      method: init.method,
      headers: { "Content-Type": init.contentType },
      body: init.body,
      // A pre-signed URL answers directly; a redirect would need the body re-sent elsewhere.
      redirect: "error",
      signal: AbortSignal.timeout(opts.putTimeoutMs ?? DEFAULT_PUT_TIMEOUT_MS),
    });
  } catch (e) {
    throw toFetchError(e, url, { prefix: "fal storage upload: " });
  }
  if (!response.ok) throw await httpErrorFromResponse(response, url);
  return response;
}

/** Upload `file` to fal storage and return its public `file_url`. */
export async function uploadToFalStorage(opts: FalUploadOptions): Promise<string> {
  if (opts.file.size > FAL_MULTIPART_THRESHOLD_BYTES) return multipartUpload(opts);

  const { uploadUrl, fileUrl } = await initiate(opts, false);
  await withRetries(opts, "Upload", async () => {
    const res = await sendUnauthenticated(opts, uploadUrl.href, {
      method: "PUT",
      body: opts.file,
      contentType: opts.contentType,
    });
    await res.body?.cancel().catch(() => {});
  });
  return fileUrl.href;
}

async function multipartUpload(opts: FalUploadOptions): Promise<string> {
  const { uploadUrl, fileUrl } = await initiate(opts, true);
  const base = `${uploadUrl.origin}${uploadUrl.pathname}`;
  const parts = Math.ceil(opts.file.size / FAL_PART_BYTES);
  const done: Array<{ partNumber: unknown; etag: unknown }> = [];

  for (let i = 0; i < parts; i++) {
    const partNumber = i + 1;
    const chunk = opts.file.slice(
      i * FAL_PART_BYTES,
      Math.min((i + 1) * FAL_PART_BYTES, opts.file.size),
    );
    opts.onProgress?.(`Uploading part ${partNumber}/${parts}`);
    const part = await withRetries(opts, `Part ${partNumber}`, async () => {
      const res = await sendUnauthenticated(opts, `${base}/${partNumber}${uploadUrl.search}`, {
        method: "PUT",
        body: chunk,
        contentType: "application/octet-stream",
      });
      try {
        return (await res.json()) as PartResponse;
      } catch {
        throw new HttpError(res.status, "Invalid JSON from part upload", base);
      }
    });
    if (part?.etag === undefined) {
      throw new ProviderError(`fal storage did not return an etag for part ${partNumber}`, "fal");
    }
    done.push({ partNumber: part.partNumber ?? partNumber, etag: part.etag });
  }

  await withRetries(opts, "Upload complete", async () => {
    const res = await sendUnauthenticated(opts, `${base}/complete${uploadUrl.search}`, {
      method: "POST",
      body: JSON.stringify({ parts: done }),
      contentType: "application/json",
    });
    await res.body?.cancel().catch(() => {});
  });
  return fileUrl.href;
}
