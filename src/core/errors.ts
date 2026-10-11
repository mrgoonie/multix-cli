/**
 * Custom error hierarchy for multix CLI.
 * All errors carry a short `code` string for programmatic handling.
 */

import { redactUrl } from "./redact.js";

export class MultixError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "MultixError";
    // Maintain proper stack trace in V8. Typed locally so the file also
    // type-checks without Node typings (the Cloudflare Worker build).
    (Error as { captureStackTrace?: (target: object, ctor?: unknown) => void }).captureStackTrace?.(
      this,
      this.constructor,
    );
  }
}

/** Missing or invalid configuration (env vars, flags). */
export class ConfigError extends MultixError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR");
    this.name = "ConfigError";
  }
}

/** Provider API returned an error or unexpected response. */
export class ProviderError extends MultixError {
  constructor(
    message: string,
    public readonly provider: string,
  ) {
    super(message, "PROVIDER_ERROR");
    this.name = "ProviderError";
  }
}

/** Input validation failed (zod parse, file not found, etc.). */
export class ValidationError extends MultixError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

/**
 * HTTP request failed. The message and `url` show the request URL with its
 * query string redacted so API keys and signed-URL tokens never reach
 * terminal, CI or Worker logs; `rawUrl` keeps the original (non-enumerable).
 */
export class HttpError extends MultixError {
  /** Request URL with query string and fragment redacted — safe to log or serialize. */
  public readonly url: string;
  /** Raw request URL. Non-enumerable so JSON.stringify/console output never includes it. */
  public declare readonly rawUrl: string;

  constructor(
    public readonly status: number,
    public readonly snippet: string,
    url: string,
    /** Parsed Retry-After header (ms), when the server sent one. */
    public readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status} from ${redactUrl(url)}: ${snippet}`, "HTTP_ERROR");
    this.url = redactUrl(url);
    Object.defineProperty(this, "rawUrl", { value: url, enumerable: false });
    this.name = "HttpError";
  }
}
