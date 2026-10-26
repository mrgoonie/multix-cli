/**
 * Custom error hierarchy for multix CLI.
 * All errors carry a short `code` string for programmatic handling.
 */

import { redactUrl } from "./redact.js";

export class MultixError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
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
  constructor(message: string, options?: ErrorOptions) {
    super(message, "CONFIG_ERROR", options);
    this.name = "ConfigError";
  }
}

/** Provider API returned an error or unexpected response. */
export class ProviderError extends MultixError {
  constructor(
    message: string,
    public readonly provider: string,
    options?: ErrorOptions,
  ) {
    super(message, "PROVIDER_ERROR", options);
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
    options?: ErrorOptions,
  ) {
    super(`HTTP ${status} from ${redactUrl(url)}: ${snippet}`, "HTTP_ERROR", options);
    this.url = redactUrl(url);
    Object.defineProperty(this, "rawUrl", { value: url, enumerable: false });
    this.name = "HttpError";
  }
}

/**
 * A response body exceeded the caller's byte cap; reading stopped there.
 * Not an HttpError, so polling and retry helpers never fetch it again.
 */
export class ResponseTooLargeError extends MultixError {
  /** Request URL with query string and fragment redacted. */
  public readonly url: string;

  constructor(
    public readonly limitBytes: number,
    url: string,
  ) {
    super(
      `Response from ${redactUrl(url)} is larger than ${limitBytes} bytes`,
      "RESPONSE_TOO_LARGE",
    );
    this.url = redactUrl(url);
    this.name = "ResponseTooLargeError";
  }
}

/**
 * A spend guard refused the run before anything was sent: the estimate is over
 * the caller's limit (BUDGET_EXCEEDED), the cost cannot be bounded
 * (BUDGET_UNPROVEN), or the limit itself is malformed (INVALID_INPUT).
 */
export class BudgetError extends MultixError {
  constructor(message: string, code: "BUDGET_EXCEEDED" | "BUDGET_UNPROVEN" | "INVALID_INPUT") {
    super(message, code);
    this.name = "BudgetError";
  }
}
