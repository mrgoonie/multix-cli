/**
 * Request and response helpers for the REST API: JSON bodies with a size
 * limit, the `{ "error": { "code", "message" } }` error shape, and mapping
 * of thrown errors to HTTP statuses. Error messages never carry submitted
 * values; job output is scrubbed by the job runner before it gets here.
 */

import { MultixError } from "../../../src/core/errors.js";
import { MAX_BODY_BYTES } from "../config.js";
import { BodyTooLargeError, readBodyLimited } from "../http-guards.js";
import { json } from "../http-responses.js";
import { JobCapacityError, JobNotFoundError } from "../jobs/job-runner.js";
import { logEvent, sanitizeText } from "../redaction.js";

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "method_not_allowed"
  | "payload_too_large"
  | "unsupported_media_type"
  | "rate_limited"
  | "busy"
  | "limit_reached"
  | "unavailable"
  | "storage_check_failed"
  | "internal";

/** A failure with a fixed code and a caller-safe message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json(status, { error: { code, message } }, headers);
}

/** Parse a JSON object body (application/json, at most MAX_BODY_BYTES). */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    throw new ApiError(415, "unsupported_media_type", "Send the body as application/json");
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBodyLimited(request, MAX_BODY_BYTES));
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      throw new ApiError(
        413,
        "payload_too_large",
        `The body must be at most ${MAX_BODY_BYTES} bytes`,
      );
    }
    throw new ApiError(400, "bad_request", "The body is not valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "bad_request", "The body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/**
 * Turn a thrown error into a response. Expected errors keep their message
 * (validation, unknown job, capacity) after the caller's key values, bearer
 * tokens and URL query strings are scrubbed; anything else is logged and
 * becomes a generic 500.
 */
export function errorResponse(
  error: unknown,
  route: string,
  secrets: readonly string[] = [],
): Response {
  if (error instanceof ApiError) {
    return apiError(error.status, error.code, error.message, error.headers);
  }
  if (error instanceof JobNotFoundError) return apiError(404, "not_found", error.message);
  if (error instanceof JobCapacityError) {
    return apiError(429, "busy", error.message, { "retry-after": "60" });
  }
  if (error instanceof MultixError) {
    return apiError(400, "bad_request", sanitizeText(error.message, secrets));
  }
  logEvent("error", "api_error", {
    route,
    error: error instanceof Error ? error.name : "unknown",
  });
  return apiError(500, "internal", "Internal error");
}
