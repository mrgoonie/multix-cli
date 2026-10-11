/**
 * Redirect handling for requests that carry credentials (API key headers).
 * Runtime-neutral: no node:* imports, so provider HTTP clients that also run
 * outside Node (e.g. a Cloudflare Worker) can share it.
 *
 * fetch() follows redirects by itself and, per the Fetch spec, strips only
 * `Authorization` on a cross-origin hop: custom key headers such as
 * `X-Api-Key` or `x-goog-api-key` would be forwarded to the new origin. The
 * helpers here follow redirects one hop at a time instead, so request headers
 * never reach another origin (an https to http hop is an origin change too).
 */

import { HttpError } from "./errors.js";
import { toFetchError } from "./fetch-error.js";
import type { UrlValidator } from "./url-safety.js";

/** Minimal fetch signature (matches globalThis.fetch for string URLs). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Headers describing a request body; removed when a redirect turns the request into a GET. */
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language"];

export interface FollowRedirectsOptions {
  /**
   * Called (and awaited) with the URL and every redirect target before it is
   * fetched, and with a response URL that differs from the requested one;
   * throw to refuse.
   */
  validateUrl?: UrlValidator;
  /** Default 5. */
  maxRedirects?: number;
  /** Defaults to globalThis.fetch (resolved at call time so tests can stub it). */
  fetch?: FetchLike;
  /**
   * A redirect to another origin: "drop-headers" (default) follows it without
   * the request headers, for downloads that hand off to a storage host;
   * "error" refuses it with an HttpError, and "stop" returns the 3xx response
   * unfollowed (like `redirect: "manual"`), for API calls whose host never
   * sends one.
   */
  crossOrigin?: "drop-headers" | "error" | "stop";
  /**
   * Map fetch rejections with `toFetchError`: network failures become
   * HttpError(0) naming the hop, deterministic ones a ConfigError or
   * ProviderError. Default false (rethrow as is).
   */
  wrapNetworkErrors?: boolean;
}

export interface RedirectFetchResult {
  response: Response;
  /** The URL of the last hop, i.e. the one `response` came from. */
  url: string;
}

function withoutBodyHeaders(headers: RequestInit["headers"]): Headers | undefined {
  if (headers === undefined) return undefined;
  const copy = new Headers(headers);
  for (const name of BODY_HEADERS) copy.delete(name);
  return copy;
}

/**
 * fetch() with `redirect: "manual"`, following up to `maxRedirects` redirects
 * by hand. Request headers never reach another origin: they are dropped (or
 * the redirect refused, see `crossOrigin`) once a hop changes origin. Method
 * and body follow the Fetch spec: 303 (and 301/302 after a POST) switch to a
 * body-less GET; 307/308 resend them. Each redirect body is cancelled. A
 * relative Location resolves against the current hop.
 */
export async function fetchFollowingRedirects(
  url: string,
  init: RequestInit = {},
  opts: FollowRedirectsOptions = {},
): Promise<RedirectFetchResult> {
  const doFetch: FetchLike = opts.fetch ?? ((input, i) => globalThis.fetch(input, i));
  const { validateUrl } = opts;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  let current = url;
  let hopInit: RequestInit = { ...init, redirect: "manual" };
  for (let hop = 0; ; hop++) {
    await validateUrl?.(current);
    let response: Response;
    try {
      response = await doFetch(current, hopInit);
    } catch (cause) {
      if (!opts.wrapNetworkErrors) throw cause;
      throw toFetchError(cause, current);
    }
    // A runtime that followed a redirect despite "manual" reports where it ended up.
    if (validateUrl && response.url && response.url !== current) {
      try {
        await validateUrl(response.url);
      } catch (err) {
        await response.body?.cancel().catch(() => {});
        throw err;
      }
    }
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return { response, url: current };
    }
    let next: URL | undefined;
    try {
      next = new URL(location, current);
    } catch {
      // reported below, once the body is cancelled
    }
    const crossOrigin = next !== undefined && next.origin !== new URL(current).origin;
    if (crossOrigin && opts.crossOrigin === "stop") return { response, url: current };
    await response.body?.cancel().catch(() => {});
    if (hop >= maxRedirects) {
      throw new HttpError(response.status, `too many redirects (over ${maxRedirects})`, current);
    }
    if (!next) {
      throw new HttpError(response.status, "redirect with a malformed Location header", current);
    }
    if (crossOrigin) {
      if (opts.crossOrigin === "error") {
        throw new HttpError(
          response.status,
          `refusing to follow a redirect to another origin (${next.origin})`,
          current,
        );
      }
      hopInit = { ...hopInit, headers: undefined };
    }
    const method = (hopInit.method ?? "GET").toUpperCase();
    const toGet =
      (response.status === 303 && method !== "GET" && method !== "HEAD") ||
      ((response.status === 301 || response.status === 302) && method === "POST");
    if (toGet) {
      hopInit = {
        ...hopInit,
        method: "GET",
        body: undefined,
        headers: withoutBodyHeaders(hopInit.headers),
      };
    }
    current = next.toString();
  }
}

/**
 * Drop-in for fetch() on API requests that carry a key: same-origin redirects
 * are followed (by hand), while a redirect to any other origin is not: its 3xx
 * response is returned as is, so the caller's usual non-2xx handling reports
 * it and the key is never sent there. Network errors are rethrown as is.
 */
export async function fetchSameOrigin(
  url: string,
  init: RequestInit = {},
  fetchImpl?: FetchLike,
): Promise<Response> {
  const { response } = await fetchFollowingRedirects(url, init, {
    fetch: fetchImpl,
    crossOrigin: "stop",
  });
  return response;
}

export interface RedirectFetchOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /**
   * Called (and awaited) with the URL and every redirect target before it is
   * fetched; throw to refuse. When `validateUrl` or `headers` is set,
   * redirects are followed manually (at most `maxRedirects`) and `headers` are
   * dropped once a redirect changes origin. Otherwise fetch follows redirects
   * itself.
   */
  validateUrl?: UrlValidator;
  /** Default 5. */
  maxRedirects?: number;
  /** Defaults to globalThis.fetch (resolved at call time so tests can stub it). */
  fetch?: FetchLike;
}

/**
 * GET a URL, following redirects one hop at a time so every target is
 * validated before it is requested and headers never reach another origin.
 * Network failures become HttpError(0) naming the hop that failed; other
 * fetch rejections are mapped by `toFetchError`.
 */
export async function fetchWithValidatedRedirects(
  url: string,
  opts: RedirectFetchOptions = {},
): Promise<RedirectFetchResult> {
  const { signal, headers, validateUrl } = opts;
  const init: RequestInit = { ...(signal ? { signal } : {}), ...(headers ? { headers } : {}) };
  if (!validateUrl && !headers) {
    const doFetch: FetchLike = opts.fetch ?? ((input, i) => globalThis.fetch(input, i));
    try {
      return { response: await doFetch(url, init), url };
    } catch (cause) {
      throw toFetchError(cause, url);
    }
  }
  return fetchFollowingRedirects(url, init, {
    validateUrl,
    maxRedirects: opts.maxRedirects,
    fetch: opts.fetch,
    wrapNetworkErrors: true,
  });
}
