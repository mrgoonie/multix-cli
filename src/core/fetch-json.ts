/**
 * Runtime-neutral JSON-over-HTTP helper (no node:* imports).
 * Provider clients that must also run outside Node (e.g. a Cloudflare Worker)
 * use this with an injected `fetch`; the CLI's `httpJson` delegates here.
 */

import { HttpError } from "./errors.js";
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
  timeoutMs?: number;
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

/**
 * Make an HTTP request and parse the JSON response.
 * Throws HttpError on non-2xx status or network failure (status 0). Redirects
 * are followed within the same origin only; one to another origin is refused
 * (HttpError with the 3xx status) so the key headers are never sent there.
 */
export async function fetchJson<T>(opts: FetchJsonOptions): Promise<T> {
  const { url, method = "GET", headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));

  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  // Same-origin redirects only: the request headers usually carry an API key.
  const { response } = await fetchFollowingRedirects(url, init, {
    fetch: doFetch,
    crossOrigin: "error",
    wrapNetworkErrors: true,
  });

  if (!response.ok) {
    throw await httpErrorFromResponse(response, url);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new HttpError(0, `Failed to read response body: ${msg}`, url);
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
