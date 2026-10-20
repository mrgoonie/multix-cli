/**
 * Runtime-neutral JSON-over-HTTP helper (no node:* imports).
 * Provider clients that must also run outside Node (e.g. a Cloudflare Worker)
 * use this with an injected `fetch`; the CLI's `httpJson` delegates here.
 */

import { HttpError, ResponseTooLargeError } from "./errors.js";
import { type FetchLike, fetchFollowingRedirects } from "./redirect-fetch.js";

export type { FetchLike };

export const DEFAULT_TIMEOUT_MS = 120_000;
const SNIPPET_MAX = 500;

export interface FetchJsonOptions {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  // biome-ignore lint/suspicious/noExplicitAny: generic JSON body
  body?: Record<string, unknown> | unknown[] | any;
  /** Whole request, response body included. Default 120 s. */
  timeoutMs?: number;
  /**
   * Time allowed until the response headers arrive (default: `timeoutMs`).
   * The body may then take the rest of `timeoutMs`, so a large body is not
   * cut off by a limit meant to catch a request that never gets an answer.
   */
  responseTimeoutMs?: number;
  /**
   * Stop reading and throw ResponseTooLargeError once the body is larger than
   * this (checked against Content-Length first, then while streaming).
   */
  maxBytes?: number;
  /**
   * Once the response has started, give up when no body bytes arrive for this
   * long (HttpError 0, worth retrying). A body that keeps moving may take the
   * rest of `timeoutMs`.
   */
  idleTimeoutMs?: number;
  /** Defaults to globalThis.fetch, resolved at call time so tests can stub it. */
  fetch?: FetchLike;
}

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 * Returns undefined when absent or unparseable.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Build an HttpError from a non-2xx response, reading a bounded body snippet. */
export async function httpErrorFromResponse(response: Response, url: string): Promise<HttpError> {
  let snippet = "";
  try {
    const text = await response.text();
    snippet = text.slice(0, SNIPPET_MAX);
  } catch {
    snippet = "(could not read body)";
  }
  return new HttpError(
    response.status,
    snippet,
    url,
    parseRetryAfter(response.headers.get("retry-after")),
  );
}

/** Request headers that never carry a credential. */
const NON_CREDENTIAL_HEADERS = new Set(["accept", "accept-language", "content-type", "user-agent"]);

/** True when any header falls outside the non-credential set (it may hold a key). */
function carriesCredentialHeaders(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => !NON_CREDENTIAL_HEADERS.has(name.toLowerCase()));
}

/**
 * Make an HTTP request and parse the JSON response.
 * Throws HttpError on non-2xx status or network failure (status 0); a
 * deterministic fetch rejection (invalid header or URL) becomes a
 * non-retryable ConfigError or ProviderError (see `toFetchError`). When the
 * request carries a header that may be a credential (anything but Accept,
 * Accept-Language, Content-Type, User-Agent), redirects are followed within
 * the same origin only; one to another origin is refused (HttpError with the
 * 3xx status) so the key is never sent there. Requests without such headers
 * follow redirects to any origin.
 */
export async function fetchJson<T>(opts: FetchJsonOptions): Promise<T> {
  const { url, method = "GET", headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));

  const { signal, responseReceived, done } = requestSignal(timeoutMs, opts.responseTimeoutMs);
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    signal,
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  // A request with a header that may be a credential follows same-origin
  // redirects only; an unkeyed one (public catalogs, registries) follows any.
  let response: Response;
  try {
    ({ response } = await fetchFollowingRedirects(url, init, {
      fetch: doFetch,
      crossOrigin: carriesCredentialHeaders(headers) ? "error" : "drop-headers",
      wrapNetworkErrors: true,
    }));
  } finally {
    responseReceived();
  }

  let text: string;
  try {
    if (!response.ok) {
      throw await httpErrorFromResponse(response, url);
    }
    text = await readText(response, opts, url);
  } catch (cause) {
    if (cause instanceof ResponseTooLargeError || cause instanceof HttpError) throw cause;
    // A body too long for one JavaScript string is too large, not a network failure.
    if (cause instanceof RangeError && opts.maxBytes !== undefined) {
      throw new ResponseTooLargeError(opts.maxBytes, url);
    }
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new HttpError(0, `Failed to read response body: ${msg}`, url);
  } finally {
    done();
  }
  if (text.trim() === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(
      response.status,
      `Invalid JSON response: ${text.slice(0, SNIPPET_MAX)}`,
      url,
    );
  }
}

/**
 * Abort signal for the whole request (`timeoutMs`), also aborted when the
 * response headers take longer than `responseTimeoutMs`. Call
 * `responseReceived` once they arrive (or the request failed), and `done`
 * once the body has been read.
 */
function requestSignal(
  timeoutMs: number,
  responseTimeoutMs: number | undefined,
): { signal: AbortSignal; responseReceived: () => void; done: () => void } {
  const overall = AbortSignal.timeout(timeoutMs);
  if (responseTimeoutMs === undefined || responseTimeoutMs >= timeoutMs) {
    return { signal: overall, responseReceived: () => {}, done: () => {} };
  }
  const controller = new AbortController();
  const onOverall = () => controller.abort(overall.reason);
  overall.addEventListener("abort", onOverall, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException("The response took too long to start", "TimeoutError")),
    responseTimeoutMs,
  );
  return {
    signal: controller.signal,
    responseReceived: () => clearTimeout(timer),
    done: () => {
      clearTimeout(timer);
      overall.removeEventListener("abort", onOverall);
    },
  };
}

/**
 * The body as text, read in chunks: abandoned once it passes `maxBytes`, or
 * when no chunk arrives for `idleTimeoutMs`.
 */
async function readText(
  response: Response,
  opts: Pick<FetchJsonOptions, "maxBytes" | "idleTimeoutMs">,
  url: string,
): Promise<string> {
  const { maxBytes = Number.POSITIVE_INFINITY, idleTimeoutMs } = opts;
  if ((opts.maxBytes === undefined && idleTimeoutMs === undefined) || !response.body) {
    return response.text();
  }
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw new ResponseTooLargeError(maxBytes, url);
  }
  // Content-Length can be absent or wrong, so count the bytes actually received.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await readChunk(reader, idleTimeoutMs, url);
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError(maxBytes, url);
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

/** One `reader.read()`, cancelling the stream if it takes longer than `idleTimeoutMs`. */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number | undefined,
  url: string,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  if (idleTimeoutMs === undefined) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject before cancelling: a cancel settles the pending read as done.
      reject(
        new HttpError(
          0,
          `Failed to read response body: no data for ${Math.round(idleTimeoutMs / 1000)} s`,
          url,
        ),
      );
      reader.cancel().catch(() => {});
    }, idleTimeoutMs);
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
