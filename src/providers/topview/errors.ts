/**
 * TopView error types and mapping for both surfaces. Runtime-neutral.
 *
 * Legacy API business errors arrive as `{ code: "<4-digit>", message }`
 * (documented codes: 4000-4007 request errors, 4100 credit not enough,
 * 5000-5005 server errors, 6001 security problem); the gateway answers an
 * invalid or missing key with HTTP 401 `{ "error": "..." }`.
 * API Platform errors arrive as `{ error: { code, message, retryable },
 * requestId, code, message }` (e.g. 401 UNAUTHENTICATED, 403 IDENTITY_FORBIDDEN).
 */

import { HttpError, ProviderError } from "../../core/errors.js";
import {
  TOPVIEW_API_SETTINGS_LINK,
  TOPVIEW_DASHBOARD_LINK,
  TOPVIEW_PLATFORM_CONSOLE_LINK,
} from "./models.js";
import type { LegacyTask, PlatformPrediction } from "./types.js";

export const PROVIDER = "topview";
const DETAIL_MAX = 300;

/** TopView API error with an actionable message; keeps the HTTP status and the API's own code. */
export class TopviewApiError extends ProviderError {
  constructor(
    message: string,
    public readonly status: number,
    /** Legacy business code ("4100") or Platform error code ("UNAUTHENTICATED"). */
    public readonly apiCode?: string,
    public readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, PROVIDER, options);
    this.name = "TopviewApiError";
  }

  /** A legacy 5xxx business code (server side, worth retrying a read). */
  get isLegacyServerError(): boolean {
    return this.status === 200 && /^5\d{3}$/.test(this.apiCode ?? "");
  }
}

/** A legacy task reached `fail`, or finished without the output the next step needs. */
export class TopviewTaskError extends ProviderError {
  constructor(
    public readonly task: LegacyTask,
    detail?: string,
  ) {
    const why = detail ?? (task.errorMsg ? `: ${task.errorMsg.slice(0, DETAIL_MAX)}` : "");
    super(`TopView ${task.kind} task ${task.taskId} ${task.status}${why}`, PROVIDER);
    this.name = "TopviewTaskError";
  }
}

/** A prediction ended `failed` or `payment_required`: never a success. */
export class TopviewPredictionError extends ProviderError {
  constructor(public readonly prediction: PlatformPrediction) {
    super(predictionFailureMessage(prediction), PROVIDER);
    this.name = "TopviewPredictionError";
  }
}

function predictionFailureMessage(p: PlatformPrediction): string {
  if (p.status === "payment_required") {
    const due = p.amount_due_usd ? ` Amount due: $${p.amount_due_usd}.` : "";
    const shortfall = p.shortfall_usd ? ` Shortfall: $${p.shortfall_usd}.` : "";
    return `TopView prediction ${p.id} needs payment (payment_required).${due}${shortfall} Top up the same API Platform workspace at ${TOPVIEW_PLATFORM_CONSOLE_LINK}; settlement retries automatically without resubmitting. Then resume with: multix topview prediction ${p.id} --wait --download`;
  }
  const detail = p.error ? `: ${p.error.slice(0, DETAIL_MAX)}` : "";
  return `TopView prediction ${p.id} ${p.status}${detail}`;
}

/**
 * A proxy or gateway may echo the Authorization header in its error body.
 * Rebuild such an HttpError without the secret (and without the original as
 * its cause) before anything maps, stores or prints it.
 */
export function scrubSecret(error: unknown, secret: string): unknown {
  if (!(error instanceof HttpError) || !secret || !error.snippet.includes(secret)) return error;
  const snippet = error.snippet.split(secret).join("[redacted]");
  return new HttpError(error.status, snippet, error.rawUrl, error.retryAfterMs);
}

function parseJson(snippet: string): Record<string, unknown> | undefined {
  try {
    const body = JSON.parse(snippet) as unknown;
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function clip(text: string): string {
  return text.trim().slice(0, DETAIL_MAX);
}

// ---------------------------------------------------------------------------
// Legacy API
// ---------------------------------------------------------------------------

/** Actionable message for a legacy business code (HTTP 200, `code` != "200"). */
export function legacyBusinessError(
  code: string,
  message: string | undefined,
  subject: string,
): TopviewApiError {
  const detail = message ? `: ${clip(message)}` : "";
  let text: string;
  if (code === "4100") {
    text = `TopView credits are not enough for ${subject} (4100). Legacy API credits are your topview.ai plan credits (not the API Platform balance); check \`multix topview credit\` and top up at ${TOPVIEW_DASHBOARD_LINK}`;
  } else if (code === "4007") {
    text =
      "TopView is still running an earlier task of this kind (4007); wait for it to finish (`multix topview status <kind> <taskId> --wait`) before submitting again";
  } else if (code === "4004") {
    text = `TopView could not find ${subject} (4004)${detail}`;
  } else if (/^400\d$/.test(code)) {
    text = `TopView rejected the request for ${subject} (${code})${detail}`;
  } else if (/^5\d{3}$/.test(code)) {
    text = `TopView server error for ${subject} (${code})${detail}. Try again later`;
  } else if (code === "6001") {
    text = `TopView refused ${subject}: security problem detected (6001)${detail}`;
  } else {
    text = `TopView request for ${subject} failed (${code})${detail}`;
  }
  return new TopviewApiError(text, 200, code);
}

/** Map an HTTP failure from the legacy API to an actionable message. */
export function mapLegacyError(error: unknown, subject: string): unknown {
  if (!(error instanceof HttpError)) return error;
  const body = parseJson(error.snippet);
  const gateway = typeof body?.error === "string" ? body.error : undefined;
  const bodyMessage = typeof body?.message === "string" ? body.message : undefined;
  const raw = gateway ?? bodyMessage ?? (body ? "" : error.snippet);
  const detail = raw ? `: ${clip(raw)}` : "";
  const { status, retryAfterMs } = error;
  // Some business errors may come with a non-200 status; keep their code.
  if (status !== 0 && typeof body?.code === "string" && /^\d{4}$/.test(body.code)) {
    const mapped = legacyBusinessError(body.code, bodyMessage, subject);
    return new TopviewApiError(mapped.message, status, body.code, retryAfterMs, { cause: error });
  }
  let message: string;
  if (status === 0) {
    message = `Network error contacting TopView${detail}`;
  } else if (status === 401) {
    message = `TopView rejected the Legacy API credentials (401${detail}). Check TOPVIEW_API_KEY and TOPVIEW_UID; both are under API Settings at ${TOPVIEW_API_SETTINGS_LINK}`;
  } else if (status === 403) {
    message = `TopView denied access to ${subject} (403)${detail}`;
  } else if (status === 404) {
    message = `TopView could not find ${subject} (404)${detail}`;
  } else if (status === 429) {
    const wait =
      retryAfterMs !== undefined ? `; retry after ${Math.ceil(retryAfterMs / 1000)}s` : "";
    message = `TopView rate limit reached (429)${wait}`;
  } else if (status >= 500) {
    message = `TopView server error (${status})${detail}. Try again later`;
  } else {
    message = `TopView request for ${subject} failed (${status})${detail}`;
  }
  return new TopviewApiError(message, status, undefined, retryAfterMs, { cause: error });
}

export const LEGACY_ORPHAN_HINT = `The task may have been created (and billed) anyway. The Legacy API has no idempotency key and no cancel; check \`multix topview credit\` (recent tasks) and ${TOPVIEW_DASHBOARD_LINK} before retrying to avoid paying twice`;

/**
 * A network error, timeout, 5xx, a 5xxx business code or an unusable 2xx body
 * on submit can happen after TopView created the task, leaving no id to
 * resume. Point the user at the credit log before they retry.
 */
export function withLegacyOrphanHint(error: unknown, extra?: string): unknown {
  const hint = extra ? `${LEGACY_ORPHAN_HINT}. ${extra}` : LEGACY_ORPHAN_HINT;
  if (error instanceof TopviewApiError) {
    const { status } = error;
    const ambiguous =
      status === 0 || status >= 500 || (status >= 200 && status < 300 && error.isLegacyServerError);
    if (!ambiguous) return error;
    return new TopviewApiError(
      `${error.message}. ${hint}`,
      status,
      error.apiCode,
      error.retryAfterMs,
      {
        cause: error.cause,
      },
    );
  }
  if (error instanceof ProviderError) {
    return new ProviderError(`${error.message}. ${hint}`, error.provider, { cause: error.cause });
  }
  return error;
}

// ---------------------------------------------------------------------------
// API Platform
// ---------------------------------------------------------------------------

interface PlatformErrorBody {
  code?: string;
  message?: string;
  requestId?: string;
}

/** Pull the error code, message and request id from a Platform error body. */
export function platformErrorBody(body: Record<string, unknown> | undefined): PlatformErrorBody {
  if (!body) return {};
  const err =
    body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : {};
  const code =
    typeof err.code === "string" ? err.code : typeof body.code === "string" ? body.code : undefined;
  const message =
    typeof err.message === "string"
      ? err.message
      : typeof body.message === "string"
        ? body.message
        : undefined;
  const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
  return { code, message, requestId };
}

/** Message for a Platform error, from the HTTP status and the API's own code. */
export function platformErrorMessage(
  status: number,
  info: PlatformErrorBody,
  subject: string,
  retryAfterMs?: number,
): string {
  const tag = info.code ? `${status} ${info.code}` : String(status);
  const detail = info.message ? `: ${clip(info.message)}` : "";
  const req = info.requestId ? ` (request ${clip(info.requestId).slice(0, 80)})` : "";
  if (status === 401) {
    return `TopView API Platform rejected TOPVIEW_PLATFORM_API_KEY (${tag}${detail})${req}. Create a key under API keys at ${TOPVIEW_PLATFORM_CONSOLE_LINK}; the Legacy TOPVIEW_API_KEY does not work here`;
  }
  if (status === 403) {
    return `TopView API Platform denied access to ${subject} (${tag}${detail})${req}. The key needs the models:generate permission to submit and requests:read to read results, the model must be allowed for the key, and a rotated key cannot read another key's tasks`;
  }
  if (status === 404) {
    return `TopView API Platform could not find ${subject} in this workspace (${tag}${detail})${req}`;
  }
  if (status === 402) {
    return `TopView API Platform needs more balance for ${subject} (${tag}${detail})${req}. Top up the workspace at ${TOPVIEW_PLATFORM_CONSOLE_LINK}`;
  }
  if (status === 429) {
    const wait =
      retryAfterMs !== undefined ? `; retry after ${Math.ceil(retryAfterMs / 1000)}s` : "";
    return `TopView API Platform rate or concurrency limit reached (${tag})${wait}${req}`;
  }
  if (status >= 500) {
    return `TopView API Platform server error (${tag}${detail})${req}. Try again later`;
  }
  return `TopView API Platform rejected the request for ${subject} (${tag}${detail})${req}`;
}

/** Map an HTTP failure from the API Platform to an actionable message. */
export function mapPlatformError(error: unknown, subject: string): unknown {
  if (!(error instanceof HttpError)) return error;
  if (error.status === 0) {
    return new TopviewApiError(
      `Network error contacting the TopView API Platform: ${clip(error.snippet)}`,
      0,
      undefined,
      undefined,
      { cause: error },
    );
  }
  const body = parseJson(error.snippet);
  const info = body ? platformErrorBody(body) : { message: error.snippet };
  return new TopviewApiError(
    platformErrorMessage(error.status, info, subject, error.retryAfterMs),
    error.status,
    info.code,
    error.retryAfterMs,
    { cause: error },
  );
}
