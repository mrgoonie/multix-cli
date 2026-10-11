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
    // Maintain proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
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
 * HTTP request failed. `url` keeps the raw request URL for programmatic use;
 * the message only shows it with the query string redacted so API keys and
 * signed-URL tokens never reach terminal or CI logs.
 */
export class HttpError extends MultixError {
  constructor(
    public readonly status: number,
    public readonly snippet: string,
    public readonly url: string,
    /** Parsed Retry-After header (ms), when the server sent one. */
    public readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status} from ${redactUrl(url)}: ${snippet}`, "HTTP_ERROR");
    this.name = "HttpError";
  }
}
