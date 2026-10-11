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
import type { UrlValidator } from "./url-safety.js";

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
  const bytes = Math.floor(mb * 1024 * 1024);
  if (bytes < 1) {
    throw new ConfigError(`${MAX_DOWNLOAD_ENV} is too small: "${raw}" MB is less than one byte`);
  }
  return bytes;
}

export interface RedirectFetchOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /**
   * Called (and awaited) with the URL and every redirect target before it is
   * fetched; throw to refuse. When set, redirects are followed manually (at
   * most `maxRedirects`) and `headers` are dropped once a redirect changes
   * origin. When unset, fetch follows redirects itself.
   */
  validateUrl?: UrlValidator;
  /** Default 5. */
  maxRedirects?: number;
  /** Defaults to globalThis.fetch (resolved at call time so tests can stub it). */
  fetch?: FetchLike;
}

export interface RedirectFetchResult {
  response: Response;
  /** The URL of the last hop, i.e. the one `response` came from. */
  url: string;
}

/**
 * GET a URL, following redirects one hop at a time so every target is
 * validated before it is requested. A relative Location resolves against the
 * current hop; each redirect body is cancelled. Network failures become
 * HttpError(0) naming the hop that failed.
 */
export async function fetchWithValidatedRedirects(
  url: string,
  opts: RedirectFetchOptions = {},
): Promise<RedirectFetchResult> {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const { validateUrl, signal } = opts;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  let current = url;
  let headers = opts.headers;
  for (let hop = 0; ; hop++) {
    await validateUrl?.(current);
    let response: Response;
    try {
      response = await doFetch(current, {
        ...(signal ? { signal } : {}),
        ...(headers ? { headers } : {}),
        ...(validateUrl ? { redirect: "manual" as const } : {}),
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new HttpError(0, msg, current);
    }
    const location = response.headers.get("location");
    if (!validateUrl || !location || response.status < 300 || response.status >= 400) {
      return { response, url: current };
    }
    await response.body?.cancel().catch(() => {});
    if (hop >= maxRedirects) {
      throw new HttpError(response.status, `too many redirects (over ${maxRedirects})`, current);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new HttpError(response.status, "redirect with a malformed Location header", current);
    }
    if (next.origin !== new URL(current).origin) headers = undefined;
    current = next.toString();
  }
}

export interface DownloadOptions {
  /** Destination path, or a function choosing it from the (successful) response. */
  dest: string | ((response: Response) => string);
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** See RedirectFetchOptions.validateUrl; may be sync or async. */
  validateUrl?: UrlValidator;
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

/** Best-effort removal that never replaces the error being reported. */
function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // ignore: e.g. EBUSY from an antivirus lock on Windows
  }
}

/** Move `from` over `to`, replacing an existing file (rename can refuse that on Windows). */
function replaceFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const existing = fs.statSync(to, { throwIfNoEntry: false });
    if (!existing?.isFile() || (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES")) {
      throw err;
    }
    fs.rmSync(to, { force: true });
    fs.renameSync(from, to);
  }
}

/**
 * Download a URL to a local file, streaming to avoid large memory usage.
 * The body is written to `<dest>.part` and renamed over `dest` only once it
 * is complete, so a failed download never truncates or removes an existing
 * file. The parent directory is created if needed. Optional URL validation
 * (per redirect hop) and a byte cap. Errors name the last hop (redacted).
 */
export async function downloadToFile(url: string, opts: DownloadOptions): Promise<DownloadResult> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const { response, url: finalUrl } = await fetchWithValidatedRedirects(url, {
    signal,
    headers: opts.headers,
    validateUrl: opts.validateUrl,
    fetch: opts.fetch,
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(response.status, "(download failed)", finalUrl);
  }
  if (!response.body) {
    throw new HttpError(0, "Response body is null", finalUrl);
  }
  const body = response.body;

  const { maxBytes } = opts;
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (maxBytes !== undefined && Number.isFinite(declared) && declared > maxBytes) {
    await body.cancel().catch(() => {});
    throw new DownloadTooLargeError(maxBytes, finalUrl);
  }

  let dest: string;
  try {
    dest = typeof opts.dest === "function" ? opts.dest(response) : opts.dest;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
  } catch (err) {
    await body.cancel().catch(() => {});
    throw err;
  }

  let bytes = 0;
  // Content-Length can be absent or wrong, so count the bytes actually received.
  async function* countBytes(source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      bytes += chunk.byteLength;
      if (maxBytes !== undefined && bytes > maxBytes)
        throw new DownloadTooLargeError(maxBytes, finalUrl);
      yield chunk;
    }
  }

  const part = `${dest}.part`;
  let fileStream: fs.WriteStream | undefined;
  try {
    fileStream = fs.createWriteStream(part);
    await pipeline(
      Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
      countBytes,
      fileStream,
    );
    replaceFile(part, dest);
  } catch (err) {
    // pipeline() rejects before the destroyed stream has released its file
    // handle; on Windows the partial file cannot be removed until then.
    // (events.once would reject on the stream's own "error" event instead.)
    if (fileStream && !fileStream.closed) {
      await new Promise<void>((resolve) => fileStream?.once("close", () => resolve()));
    }
    removeQuietly(part);
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
