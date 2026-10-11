/**
 * HTTP utilities for multix CLI providers.
 * Uses Node 20+ globalThis.fetch so tests can mock it via globalThis.fetch assignment.
 * downloadFile streams to disk without buffering the full body.
 */

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveKey } from "./env-loader.js";
import { ConfigError, HttpError, MultixError } from "./errors.js";
import {
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  type FetchJsonOptions as HttpJsonOptions,
  fetchJson,
} from "./fetch-json.js";
import { redactUrl } from "./redact.js";

export type { HttpJsonOptions };

/**
 * Make an HTTP request and parse the JSON response.
 * Throws HttpError on non-2xx status.
 */
export async function httpJson<T>(opts: HttpJsonOptions): Promise<T> {
  return fetchJson<T>(opts);
}

export const MAX_DOWNLOAD_ENV = "MULTIX_MAX_DOWNLOAD_MB";
const DEFAULT_MAX_DOWNLOAD_MB = 2048;
const MAX_REDIRECTS = 5;

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A download exceeded its byte cap; the partial file has been removed. */
export class DownloadTooLargeError extends MultixError {
  constructor(
    public readonly limitBytes: number,
    url: string,
  ) {
    super(
      `Download from ${redactUrl(url)} exceeds the ${formatMb(limitBytes)} limit (set ${MAX_DOWNLOAD_ENV} to change it)`,
      "DOWNLOAD_TOO_LARGE",
    );
    this.name = "DownloadTooLargeError";
  }
}

/** Download size cap in bytes: MULTIX_MAX_DOWNLOAD_MB, default 2048 MB. */
export function maxDownloadBytes(): number {
  const raw = resolveKey(MAX_DOWNLOAD_ENV)?.trim();
  if (!raw) return DEFAULT_MAX_DOWNLOAD_MB * 1024 * 1024;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb <= 0) {
    throw new ConfigError(
      `${MAX_DOWNLOAD_ENV} must be a positive number of megabytes, got "${raw}"`,
    );
  }
  return Math.floor(mb * 1024 * 1024);
}

export interface DownloadOptions {
  /** Destination path, or a function choosing it from the (successful) response. */
  dest: string | ((response: Response) => string);
  timeoutMs?: number;
  headers?: Record<string, string>;
  /**
   * Called with the URL and every redirect target before it is fetched; throw
   * to refuse. When set, redirects are followed manually (at most 5) and
   * `headers` are dropped once a redirect changes origin.
   */
  validateUrl?: (url: string) => void;
  /** Abort and remove the partial file once the body exceeds this many bytes. */
  maxBytes?: number;
  /** Defaults to globalThis.fetch (resolved at call time so tests can stub it). */
  fetch?: FetchLike;
}

export interface DownloadResult {
  dest: string;
  contentType?: string;
  bytes: number;
}

async function fetchForDownload(
  url: string,
  opts: DownloadOptions,
  signal: AbortSignal,
): Promise<Response> {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const validate = opts.validateUrl;
  let current = url;
  let headers = opts.headers;
  for (let hop = 0; ; hop++) {
    validate?.(current);
    let response: Response;
    try {
      response = await doFetch(current, {
        signal,
        ...(headers ? { headers } : {}),
        ...(validate ? { redirect: "manual" as const } : {}),
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new HttpError(0, msg, current);
    }
    const location = response.headers.get("location");
    if (!validate || !location || response.status < 300 || response.status >= 400) {
      return response;
    }
    await response.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) {
      throw new HttpError(response.status, `too many redirects (over ${MAX_REDIRECTS})`, url);
    }
    const next = new URL(location, current);
    if (next.origin !== new URL(current).origin) headers = undefined;
    current = next.toString();
  }
}

/**
 * Download a URL to a local file, streaming to avoid large memory usage.
 * The parent directory is created if needed; a partial file is removed on
 * failure. Optional URL validation (per redirect hop) and a byte cap.
 */
export async function downloadToFile(url: string, opts: DownloadOptions): Promise<DownloadResult> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const response = await fetchForDownload(url, opts, signal);

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(response.status, "(download failed)", url);
  }
  if (!response.body) {
    throw new HttpError(0, "Response body is null", url);
  }

  const { maxBytes } = opts;
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (maxBytes !== undefined && Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw new DownloadTooLargeError(maxBytes, url);
  }

  const dest = typeof opts.dest === "function" ? opts.dest(response) : opts.dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let bytes = 0;
  // Content-Length can be absent or wrong, so count the bytes actually received.
  async function* countBytes(source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      bytes += chunk.byteLength;
      if (maxBytes !== undefined && bytes > maxBytes)
        throw new DownloadTooLargeError(maxBytes, url);
      yield chunk;
    }
  }

  const fileStream = fs.createWriteStream(dest);
  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      countBytes,
      fileStream,
    );
  } catch (err) {
    // pipeline() rejects before the destroyed stream has released its file
    // handle; on Windows the partial file cannot be removed until then.
    // (events.once would reject on the stream's own "error" event instead.)
    if (!fileStream.closed) {
      await new Promise<void>((resolve) => fileStream.once("close", () => resolve()));
    }
    fs.rmSync(dest, { force: true });
    throw err;
  }
  return { dest, contentType: response.headers.get("content-type") ?? undefined, bytes };
}

/**
 * Download a URL to a local file path, streaming to avoid large memory usage.
 * Parent directory is created if it does not exist.
 * Resolves with the response Content-Type (if any) so callers can name
 * extensionless outputs.
 */
export async function downloadFile(
  url: string,
  dest: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  headers?: Record<string, string>,
): Promise<string | undefined> {
  const result = await downloadToFile(url, { dest, timeoutMs, headers });
  return result.contentType;
}

/**
 * Decode a data: URI or download an http(s) URL, returning raw bytes.
 */
export async function fetchBytes(urlOrDataUri: string): Promise<Buffer> {
  if (urlOrDataUri.startsWith("data:")) {
    const commaIdx = urlOrDataUri.indexOf(",");
    if (commaIdx === -1) throw new Error("Malformed data URI: missing comma");
    const encoded = urlOrDataUri.slice(commaIdx + 1);
    return Buffer.from(encoded, "base64");
  }

  let response: Response;
  try {
    response = await globalThis.fetch(urlOrDataUri, {
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new HttpError(0, msg, urlOrDataUri);
  }

  if (!response.ok) {
    throw new HttpError(response.status, "(bytes fetch failed)", urlOrDataUri);
  }

  return Buffer.from(await response.arrayBuffer());
}
