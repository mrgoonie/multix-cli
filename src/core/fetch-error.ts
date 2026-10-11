/**
 * Classify a rejected `fetch` call. Runtime-neutral (no node:* imports).
 *
 * `fetch` rejects with a TypeError both for real network failures and for
 * local, deterministic faults (a header value that is not a ByteString, an
 * invalid URL). Only the former is worth retrying, so only it becomes the
 * status-0 HttpError that `isTransientHttpError` treats as transient.
 */

import { ConfigError, HttpError, ProviderError } from "./errors.js";
import { redactUrl } from "./redact.js";

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);
const MAX_CAUSE_DEPTH = 4;

type ErrorLike = { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };

function isNetworkCode(code: unknown): boolean {
  return typeof code === "string" && (code.startsWith("UND_ERR_") || NETWORK_CODES.has(code));
}

/** True when `err` or one of its causes (a few levels deep) carries a network error code. */
function hasNetworkCause(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current; depth++) {
    const e = current as ErrorLike & { errors?: unknown };
    if (isNetworkCode(e.code)) return true;
    // Node reports a failed multi-address connect as an AggregateError.
    if (Array.isArray(e.errors) && e.errors.some((x) => isNetworkCode((x as ErrorLike)?.code))) {
      return true;
    }
    current = e.cause;
  }
  return false;
}

/**
 * True for failures worth retrying: a timeout or abort, or a TypeError whose
 * cause chain carries a network error code (connection reset, DNS, ...).
 */
export function isNetworkFetchFailure(err: unknown): boolean {
  const e = err as ErrorLike | null | undefined;
  if (!e || typeof e !== "object") return false;
  if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  return e instanceof TypeError && hasNetworkCause(e.cause);
}

/** Error message with every embedded URL stripped of its query string. */
function safeMessage(err: unknown): string {
  const e = err as ErrorLike | null | undefined;
  const msg = typeof e?.message === "string" ? e.message : String(err);
  return msg.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (u) => redactUrl(u));
}

function causeChain(err: unknown): ErrorLike[] {
  const out: ErrorLike[] = [];
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current && typeof current === "object"; depth++) {
    out.push(current as ErrorLike);
    current = (current as ErrorLike).cause;
  }
  return out;
}

/**
 * Turn a `fetch` rejection into a multix error that keeps the original as
 * `cause`:
 * - network failure or timeout: HttpError with status 0 (transient);
 * - invalid header value or URL: ConfigError (not retried);
 * - anything else: ProviderError (not retried).
 * Messages never echo header values or a URL's query string.
 */
export function toFetchError(
  err: unknown,
  url: string,
  provider = "http",
): HttpError | ConfigError | ProviderError {
  const options = { cause: err };
  if (isNetworkFetchFailure(err)) {
    const chain = causeChain(err);
    const detail = chain.length > 1 ? `${safeMessage(chain[0])}: ${safeMessage(chain[1])}` : "";
    return new HttpError(0, detail || safeMessage(err), url, undefined, options);
  }
  const target = redactUrl(url);
  if (err instanceof TypeError) {
    const chain = causeChain(err);
    const text = chain.map((e) => String(e.message ?? "")).join(" ");
    if (chain.some((e) => e.code === "ERR_INVALID_URL") || /\bURL\b/.test(text)) {
      return new ConfigError(`Invalid request URL: ${target}`, options);
    }
    if (/ByteString|header/i.test(text)) {
      return new ConfigError(
        `Invalid HTTP header value in the request to ${target}. Check the API key and other header values for non-ASCII characters such as smart quotes.`,
        options,
      );
    }
  }
  const name = (err as ErrorLike | null)?.name;
  const prefix = typeof name === "string" && name !== "Error" ? `${name}: ` : "";
  return new ProviderError(
    `Request to ${target} failed: ${prefix}${safeMessage(err)}`,
    provider,
    options,
  );
}
