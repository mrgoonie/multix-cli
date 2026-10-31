/**
 * HeyGen error mapping: turns v3 `{ error: { code, message, param } }` responses
 * into actionable messages, and models failed async jobs. Runtime-neutral.
 */

import { HttpError, ProviderError, ProviderJobFailedError } from "../../core/errors.js";
import { HEYGEN_API_SETTINGS_URL, HEYGEN_USAGE_URL } from "./models.js";
import type { HeygenApiErrorBody } from "./types.js";

/**
 * HTTP failure from the HeyGen API. Extends HttpError so shared polling treats
 * 429/5xx/network failures as transient and honours Retry-After.
 */
export class HeygenApiError extends HttpError {
  constructor(
    status: number,
    snippet: string,
    url: string,
    retryAfterMs: number | undefined,
    public readonly apiCode: string | undefined,
    public readonly apiMessage: string | undefined,
    public readonly param: string | undefined,
  ) {
    super(status, snippet, url, retryAfterMs);
    this.name = "HeygenApiError";
    this.message = describeHeygenError(status, apiCode, apiMessage, param, retryAfterMs);
  }
}

/** A HeyGen job reached a terminal failure state (failed, cancelled, paused for input). */
export class HeygenJobFailedError extends ProviderJobFailedError {
  constructor(
    message: string,
    public readonly failureCode?: string,
    /** False when the failures include a poll or a download, not only the provider's verdict. */
    terminal = true,
  ) {
    super(message, "heygen", { terminal });
    this.name = "HeygenJobFailedError";
  }
}

/** Extract `{ code, message, param }` from a (possibly truncated) error body snippet. */
export function parseHeygenErrorBody(snippet: string): Partial<HeygenApiErrorBody> {
  try {
    const parsed = JSON.parse(snippet) as { error?: Partial<HeygenApiErrorBody> | string };
    if (parsed && typeof parsed.error === "object" && parsed.error !== null) return parsed.error;
    if (parsed && typeof parsed.error === "string") return { message: parsed.error };
  } catch {
    // Body snippets are capped, so fall back to field-level extraction.
  }
  const field = (name: string) =>
    snippet.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))?.[1];
  const out: Partial<HeygenApiErrorBody> = {};
  const code = field("code");
  const message = field("message");
  const param = field("param");
  if (code) out.code = code;
  if (message) out.message = message;
  if (param) out.param = param;
  return out;
}

/** Convert a generic HttpError into a HeygenApiError with an actionable message. */
export function toHeygenApiError(error: HttpError): HeygenApiError {
  if (error instanceof HeygenApiError) return error;
  const body = error.status === 0 ? {} : parseHeygenErrorBody(error.snippet);
  return new HeygenApiError(
    error.status,
    error.snippet,
    error.url,
    error.retryAfterMs,
    body.code,
    body.message ?? (error.status === 0 ? error.snippet : undefined),
    body.param ?? undefined,
  );
}

function hintFor(status: number, code: string | undefined): string {
  if (status === 0) return "Network error reaching HeyGen — check connectivity and retry.";
  if (status === 401)
    return `Check HEYGEN_API_KEY (sent as the X-Api-Key header) or create a new key at ${HEYGEN_API_SETTINGS_URL}.`;
  if (status === 402)
    return `Add API credits or upgrade the API plan at ${HEYGEN_USAGE_URL}. HeyGen API usage is billed separately from web/app subscriptions.`;
  if (status === 403) {
    if (code === "insufficient_api_key_scope")
      return "The API key lacks the scope this operation needs — create a key with the required scopes.";
    return "The API key, workspace, or plan is not entitled to this feature (some avatar and digital-twin features require Enterprise access).";
  }
  if (status === 404) return "Check the ID. For `heygen status`, make sure --type matches the ID.";
  if (status === 409 && code === "request_in_progress")
    return "An identical request is still being processed — wait and retry.";
  if (status === 409) return "The resource is not ready or conflicts with existing state.";
  if (status === 400 || status === 422) return "Fix the request parameters and retry.";
  if (status === 429)
    return code === "quota_exceeded"
      ? `Usage quota exceeded — see ${HEYGEN_USAGE_URL}.`
      : "Rate or concurrency limit reached — wait and retry, or reduce parallel jobs.";
  if (status >= 500) return "HeyGen server error — retry later.";
  return "";
}

/** Human-readable, secret-free error message for a HeyGen API failure. */
export function describeHeygenError(
  status: number,
  code: string | undefined,
  message: string | undefined,
  param: string | undefined,
  retryAfterMs?: number,
): string {
  const label = status === 0 ? "HeyGen request failed" : `HeyGen API error ${status}`;
  const codePart = code ? ` (${code})` : "";
  const msgPart = message ? `: ${message}` : "";
  const paramPart = param ? ` (param: ${param})` : "";
  const retryPart =
    retryAfterMs !== undefined ? ` Retry after ${Math.ceil(retryAfterMs / 1000)}s.` : "";
  const hint = hintFor(status, code);
  const base = `${label}${codePart}${msgPart}${paramPart}`;
  const sentence = /[.!?]$/.test(base) ? base : `${base}.`;
  return `${sentence}${retryPart}${hint ? ` ${hint}` : ""}`;
}
