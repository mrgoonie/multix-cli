/**
 * Classify a rejected `fetch` call. Runtime-neutral (no node:* imports).
 *
 * `fetch` rejects for real transport failures and for local, deterministic
 * faults (a header value that is not a ByteString, an invalid URL, a TLS
 * certificate the runtime will never accept). Runtimes describe transport
 * failures differently: undici attaches Node error codes to the cause, while
 * a Cloudflare Worker throws codeless errors such as "Network connection
 * lost.". So a rejection is treated as a transient network failure by
 * default, and only the known-deterministic shapes below are not retried.
 */

import { ConfigError, HttpError, ProviderError } from "./errors.js";
import { redactUrl, redactUrlsInText } from "./redact.js";

type DeterministicKind = "url" | "header" | "tls" | "request";

const MAX_CAUSE_DEPTH = 4;

const TLS_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

type ErrorLike = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
  errors?: unknown;
};

function kindOfCode(code: unknown): DeterministicKind | undefined {
  if (typeof code !== "string") return undefined;
  if (code === "ERR_INVALID_URL") return "url";
  if (code === "ERR_INVALID_CHAR" || code === "ERR_INVALID_HTTP_TOKEN") return "header";
  if (TLS_CODES.has(code) || code.startsWith("CERT_") || code.startsWith("UNABLE_TO_")) {
    return "tls";
  }
  if (code === "UND_ERR_INVALID_ARG" || code === "UND_ERR_NOT_SUPPORTED") return "request";
  return undefined;
}

function kindOfMessage(message: unknown): DeterministicKind | undefined {
  if (typeof message !== "string") return undefined;
  if (/Invalid URL|Failed to parse URL/i.test(message)) return "url";
  if (
    /ByteString|is not a legal HTTP header value|invalid header value|invalid header name/i.test(
      message,
    )
  ) {
    return "header";
  }
  if (/duplex option is required|cannot have body|unexpected redirect/i.test(message)) {
    return "request";
  }
  return undefined;
}

/** The error and its causes, a few levels deep (AggregateError members included). */
function causeChain(err: unknown): ErrorLike[] {
  const out: ErrorLike[] = [];
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current && typeof current === "object"; depth++) {
    const e = current as ErrorLike;
    out.push(e);
    // Node reports a failed multi-address connect as an AggregateError.
    if (Array.isArray(e.errors)) {
      for (const member of e.errors) if (member && typeof member === "object") out.push(member);
    }
    current = e.cause;
  }
  return out;
}

/** Which deterministic fault the rejection describes, or undefined for a transient one. */
function deterministicKind(err: unknown): DeterministicKind | undefined {
  for (const e of causeChain(err)) {
    const kind = kindOfCode(e.code) ?? kindOfMessage(e.message);
    if (kind) return kind;
  }
  return undefined;
}

/**
 * True unless the rejection is a known deterministic fault (invalid URL or
 * header value, TLS certificate error, a request fetch refuses to send).
 * Timeouts, connection failures and unknown errors are worth retrying.
 * An AbortError counts as transient because every caller aborts only through
 * `AbortSignal.timeout`; a caller that passes a user cancellation signal must
 * check `signal.aborted` itself before retrying.
 */
export function isNetworkFetchFailure(err: unknown): boolean {
  return deterministicKind(err) === undefined;
}

function messageOf(e: ErrorLike | undefined): string {
  return typeof e?.message === "string" ? redactUrlsInText(e.message) : "";
}

/** "fetch failed: <first cause>" style detail, scrubbed. */
function detailOf(err: unknown): string {
  const chain = causeChain(err);
  const parts = [messageOf(chain[0]), messageOf(chain[1])].filter(Boolean);
  return parts.length > 0 ? parts.join(": ") : redactUrlsInText(String(err));
}

export interface FetchErrorOptions {
  /** Provider name for a ProviderError. Default "http". */
  provider?: string;
  /** Prepended to every message, e.g. "File upload failed: ". */
  prefix?: string;
  /** How messages name the request target. Default: the URL with its query string redacted. */
  target?: string;
}

/**
 * Turn a `fetch` rejection into a multix error that keeps the original as
 * `cause`:
 * - invalid URL or header value: ConfigError (not retried);
 * - TLS certificate error or a request fetch refuses to send: ProviderError
 *   (not retried), naming the first cause;
 * - anything else (connection failure, timeout, unknown): HttpError with
 *   status 0, which `isTransientHttpError` retries.
 * Messages never echo header values or a URL's query string.
 */
export function toFetchError(
  err: unknown,
  url: string,
  opts: FetchErrorOptions = {},
): HttpError | ConfigError | ProviderError {
  const options = { cause: err };
  const prefix = opts.prefix ?? "";
  const target = opts.target ?? redactUrl(url);
  switch (deterministicKind(err)) {
    case "url":
      return new ConfigError(`${prefix}Invalid request URL: ${target}`, options);
    case "header":
      return new ConfigError(
        `${prefix}Invalid HTTP header value in the request to ${target}. Check the API key and other header values for non-ASCII characters such as smart quotes, or line breaks.`,
        options,
      );
    case "tls":
    case "request":
      return new ProviderError(
        `${prefix}Request to ${target} failed: ${detailOf(err)}`,
        opts.provider ?? "http",
        options,
      );
    default:
      return new HttpError(0, `${prefix}${detailOf(err)}`, url, undefined, options);
  }
}
