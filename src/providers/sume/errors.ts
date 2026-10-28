/**
 * Sume error envelope (`{error:{code,message,request_id,retryable,
 * retry_after_seconds,details}}`) and its mapping to actionable messages.
 * Runtime-neutral: no node:* imports.
 */

import { HttpError, ProviderError } from "../../core/errors.js";
import { SUME_DASHBOARD_LINK } from "./models.js";
import type { SumeJob } from "./types.js";

const PROVIDER = "sume";
const DETAIL_MAX = 300;
const MAX_LISTED_ERRORS = 8;

/** The fields multix reads from Sume's error envelope. */
export interface SumeErrorEnvelope {
  code?: string;
  message?: string;
  requestId?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  details?: Record<string, unknown>;
}

/** A Sume API failure with its HTTP status and error code kept for programmatic use. */
export class SumeApiError extends ProviderError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly sumeCode?: string,
    public readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, PROVIDER, options);
    this.name = "SumeApiError";
  }
}

/** A job ended `failed` or `canceled`: never a success. Sume refunds both. */
export class SumeJobFailedError extends ProviderError {
  constructor(public readonly job: SumeJob) {
    const err = job.error;
    const code = err?.code ? ` [${err.code}]` : "";
    const why = err?.message || err?.public_reason;
    const detail = why ? `: ${clip(why)}` : "";
    super(
      `Sume job ${job.id} ${job.status}${code}${detail}. Sume refunds failed and canceled jobs, so it was not charged`,
      PROVIDER,
    );
    this.name = "SumeJobFailedError";
  }
}

/**
 * A generate request that failed after its retries ran out. `ambiguous` is
 * true when Sume may have accepted the job anyway (network error, timeout,
 * server error, unreadable 2xx), so the same idempotency key must be reused.
 */
export class SumeSubmitError extends ProviderError {
  constructor(
    message: string,
    public readonly idempotencyKey: string,
    public readonly ambiguous: boolean,
    options?: ErrorOptions,
  ) {
    super(message, PROVIDER, options);
    this.name = "SumeSubmitError";
  }
}

function clip(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, DETAIL_MAX);
}

function record(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

const strOf = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** Read `"name":"value"` / `"name":true|false|<number>` out of a truncated JSON snippet. */
function scrape(snippet: string, name: string): string | undefined {
  const m = new RegExp(
    `"${name}"\\s*:\\s*("((?:[^"\\\\]|\\\\.)*)"|true|false|-?\\d+(?:\\.\\d+)?)`,
  ).exec(snippet);
  if (!m) return undefined;
  if (m[2] !== undefined) {
    try {
      return JSON.parse(`"${m[2]}"`) as string;
    } catch {
      return m[2];
    }
  }
  return m[1];
}

/**
 * Parse the error envelope from an HTTP error snippet. The snippet is capped
 * at 500 characters, so a long body is cut off mid-JSON: fall back to reading
 * the scalar fields with a regex.
 */
export function parseErrorEnvelope(snippet: string): SumeErrorEnvelope | undefined {
  try {
    const err = record(record(JSON.parse(snippet))?.error);
    if (!err) return undefined;
    const retryAfter = err.retry_after_seconds;
    return {
      code: strOf(err.code),
      message: strOf(err.message),
      requestId: strOf(err.request_id),
      retryable: typeof err.retryable === "boolean" ? err.retryable : undefined,
      retryAfterSeconds:
        typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0
          ? retryAfter
          : undefined,
      details: record(err.details),
    };
  } catch {
    if (!/"error"\s*:\s*\{/.test(snippet)) return undefined;
    const retryable = scrape(snippet, "retryable");
    const retryAfter = Number(scrape(snippet, "retry_after_seconds"));
    const details: Record<string, unknown> = {};
    for (const key of ["required_usd", "available_usd", "limit_usd", "spend_usd", "resets_at"]) {
      const value = scrape(snippet, key);
      if (value !== undefined) details[key] = value;
    }
    return {
      code: scrape(snippet, "code"),
      message: scrape(snippet, "message"),
      requestId: scrape(snippet, "request_id"),
      retryable: retryable === "true" ? true : retryable === "false" ? false : undefined,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined,
      details: Object.keys(details).length > 0 ? details : undefined,
    };
  }
}

/** `- path: message` lines from `details.errors`. */
function validationLines(details: Record<string, unknown> | undefined): string[] {
  const errors = Array.isArray(details?.errors) ? details.errors : [];
  const lines = errors.flatMap((e) => {
    const item = record(e);
    const message = strOf(item?.message);
    if (!message) return [];
    const path = strOf(item?.path);
    return [`- ${path ? `${path}: ` : ""}${clip(message)}`];
  });
  if (lines.length > MAX_LISTED_ERRORS) {
    return [
      ...lines.slice(0, MAX_LISTED_ERRORS),
      `- …and ${lines.length - MAX_LISTED_ERRORS} more`,
    ];
  }
  return lines;
}

/** Retry delay in ms: the Retry-After header first, then the body's retry_after_seconds. */
export function retryAfterMsOf(error: HttpError): number | undefined {
  if (error.retryAfterMs !== undefined) return error.retryAfterMs;
  const seconds = parseErrorEnvelope(error.snippet)?.retryAfterSeconds;
  return seconds === undefined ? undefined : Math.round(seconds * 1000);
}

const usd = (v: unknown) => (typeof v === "string" || typeof v === "number" ? `$${v}` : undefined);

/**
 * Map an HTTP failure to an actionable SumeApiError. `subject` names what was
 * requested (`model kling-4`, `job job_…`, `upload cup.png`) so 404 and 409
 * messages point at the right fix. Non-HTTP errors pass through unchanged.
 */
export function mapSumeError(error: unknown, subject: string): unknown {
  if (!(error instanceof HttpError)) return error;
  const { status } = error;
  const env = parseErrorEnvelope(error.snippet);
  const code = env?.code;
  const retryAfterMs = retryAfterMsOf(error);
  const said = env?.message ? clip(env.message) : clip(error.snippet);
  const suffix = said ? `: ${said}` : "";
  const ref = env?.requestId ? ` (request ${env.requestId})` : "";
  const wait = retryAfterMs !== undefined ? `; retry after ${Math.ceil(retryAfterMs / 1000)}s` : "";
  const d = env?.details;
  let message: string;

  if (status === 0) {
    message = `Network error contacting Sume${suffix}`;
  } else if (status === 401) {
    message = `Sume rejected the API key (401${code ? ` ${code}` : ""}). Check SUME_API_KEY; create or copy a key in the Sume dashboard (${SUME_DASHBOARD_LINK})`;
  } else if (status === 402) {
    const need = usd(d?.required_usd);
    const have = usd(d?.available_usd);
    const amounts = need || have ? ` (needs ${need ?? "?"}, available ${have ?? "?"})` : "";
    message = `Sume balance is too low for ${subject} (402 ${code ?? "insufficient_funds"})${amounts}. Nothing was charged. Top up in the Sume dashboard (${SUME_DASHBOARD_LINK}), then run the command again`;
  } else if (status === 403 && code === "api_key_spend_limit_exceeded") {
    const parts = [
      usd(d?.limit_usd) && `limit ${usd(d?.limit_usd)}`,
      usd(d?.spend_usd) && `spent ${usd(d?.spend_usd)}`,
      typeof d?.resets_at === "string" && `resets ${d.resets_at}`,
    ].filter(Boolean);
    const extra = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    message = `This Sume API key reached its spend limit (403 api_key_spend_limit_exceeded)${extra}. Nothing was charged. Raise the key's limit in the Sume dashboard or wait for it to reset`;
  } else if (status === 403) {
    message = `Sume denied access to ${subject} (403${code ? ` ${code}` : ""})${suffix}`;
  } else if (status === 404) {
    message =
      code === "model_not_found" || subject.startsWith("model")
        ? `Sume does not offer ${subject} (404)${suffix}. Run \`multix sume models\` for the current model ids`
        : `Sume could not find ${subject} (404); it may belong to another workspace or key`;
  } else if (status === 409) {
    message = conflictMessage(code, subject, suffix, d);
  } else if (status === 400 || status === 413 || status === 415 || status === 422) {
    const lines = validationLines(d);
    const head = `Sume rejected the request for ${subject} (${status}${code ? ` ${code}` : ""})${suffix}`;
    message = lines.length > 0 ? `${head}\n${lines.join("\n")}` : head;
  } else if (status === 429 && code === "queue_full") {
    message = `Sume's job queue for this workspace is full (429 queue_full)${wait}. Nothing was created; wait for running jobs to finish and retry with the same --idempotency-key`;
  } else if (status === 429) {
    message = `Sume rate limit reached (429${code ? ` ${code}` : ""})${wait}`;
  } else if (status >= 500) {
    const retry = env?.retryable === false ? "" : `. Try again later${wait}`;
    message = `Sume server error (${status}${code ? ` ${code}` : ""})${suffix}${retry}`;
  } else {
    message = `Sume request for ${subject} failed (${status}${code ? ` ${code}` : ""})${suffix}`;
  }
  return new SumeApiError(`${message}${ref}`, status, code, retryAfterMs, { cause: error });
}

function conflictMessage(
  code: string | undefined,
  subject: string,
  suffix: string,
  details: Record<string, unknown> | undefined,
): string {
  switch (code) {
    case "job_not_completed": {
      const state = typeof details?.status === "string" ? ` (status: ${details.status})` : "";
      return `Sume ${subject} is not finished yet${state}; check again with \`multix sume status\``;
    }
    case "job_failed":
      return `Sume ${subject} failed${suffix}. Sume refunds failed jobs`;
    case "job_canceled":
      return `Sume ${subject} was canceled. Sume refunds canceled jobs`;
    case "job_generation_already_started":
      return `Sume ${subject} has already started generating and can no longer be canceled; it will finish and be charged (409 job_generation_already_started)`;
    case "job_not_cancelable":
      return `Sume ${subject} has already finished, so there is nothing to cancel (409 job_not_cancelable)`;
    case "idempotency_conflict":
      return "This idempotency key was already used for a different request (409 idempotency_conflict). Run the changed request without --idempotency-key, or with a new one";
    default:
      return `Sume refused ${subject} (409${code ? ` ${code}` : ""})${suffix}`;
  }
}

/**
 * A proxy or gateway may echo the Authorization header in its error body.
 * Rebuild such an HttpError without the key (and without the original as its
 * cause) before anything maps, stores or prints it.
 */
export function scrubSecret(error: unknown, secret: string): unknown {
  if (!(error instanceof HttpError) || !secret || !error.snippet.includes(secret)) return error;
  const snippet = error.snippet.split(secret).join("[redacted]");
  return new HttpError(error.status, snippet, error.rawUrl, error.retryAfterMs);
}
