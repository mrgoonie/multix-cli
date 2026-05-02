/**
 * Custom error hierarchy for multix CLI.
 * All errors carry a short `code` string for programmatic handling.
 */

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

/** HTTP request failed. */
export class HttpError extends MultixError {
  constructor(
    public readonly status: number,
    public readonly snippet: string,
    public readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}: ${snippet}`, "HTTP_ERROR");
    this.name = "HttpError";
  }
}
