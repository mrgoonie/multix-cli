/**
 * TopView API Platform client (https://platform-backend.topview.ai/api/v1),
 * billed in USD from a prepaid workspace balance separate from legacy credits.
 *
 * Runtime-neutral: no node:* imports; `apiKey`, `baseUrl` and `fetch` are
 * injected.
 *
 * - Submit: POST /models/{vendor}/{model}/{mode}/predictions with an
 *   Idempotency-Key. Only 408/429, network errors and retryable 5xx are
 *   retried, with the same key and the same body, a bounded number of times.
 *   402 and every other 4xx fail at once.
 * - Poll: GET /predictions/{id}; statuses created | processing |
 *   payment_required | completed | failed. "A timeout is not a confirmed
 *   failure": query the original task, never submit a duplicate.
 * - Assets: POST /media/files (multipart, at most 20 MiB) returns a signed
 *   download_url to pass in a model's image field.
 * TopView documents no cancel endpoint for predictions.
 */

import { PollTimeoutError, isTransientHttpError, pollUntil } from "../../core/async-poll.js";
import { HttpError, ProviderError } from "../../core/errors.js";
import { toFetchError } from "../../core/fetch-error.js";
import { type FetchLike, fetchJson, httpErrorFromResponse } from "../../core/fetch-json.js";
import { checkUrlSafety } from "../../core/url-safety.js";
import {
  DEFAULT_TOPVIEW_PLATFORM_BASE_URL,
  TOPVIEW_PLATFORM_DASHBOARD_LINK,
  assertPredictionId,
  isPredictionId,
} from "./models.js";
import { type PlatformModel, validatePlatformBody } from "./platform-models.js";
import type { MediaAsset, Prediction } from "./types.js";

const PROVIDER = "topview";
const DETAIL_MAX = 300;
const REQUEST_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 300_000;
export const SUBMIT_MAX_RETRIES = 3;
const SUBMIT_RETRY_BASE_MS = 2_000;
const SUBMIT_RETRY_CAP_MS = 30_000;
/** The docs: poll every 2-5 seconds, backing off for long tasks and 429/5xx. */
export const PLATFORM_POLL_INTERVAL_MS = 2_000;
export const PLATFORM_POLL_MAX_INTERVAL_MS = 5_000;
export const MEDIA_MAX_BYTES = 20 * 1024 * 1024;

/** Statuses after which polling stops. payment_required waits for a top-up, not for us. */
const STOP_STATUSES = new Set(["completed", "failed", "payment_required", "canceled", "cancelled"]);

export function isPredictionStopped(status: string): boolean {
  return STOP_STATUSES.has(status);
}

/** API Platform error; `apiCode` is the platform's error code (INVALID_API_KEY, ...). */
export class TopviewPlatformError extends ProviderError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly apiCode?: string,
    public readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, PROVIDER, options);
    this.name = "TopviewPlatformError";
  }
}

/**
 * The submit failed in a way that may still have created a prediction
 * (network error, timeout, 5xx, unreadable 2xx) and the retries ran out.
 * Re-sending the same body with the same Idempotency-Key is safe.
 */
export class TopviewAmbiguousSubmitError extends ProviderError {
  constructor(
    message: string,
    public readonly idempotencyKey: string,
    options?: ErrorOptions,
  ) {
    super(message, PROVIDER, options);
    this.name = "TopviewAmbiguousSubmitError";
  }
}

/** A prediction ended `failed` (or canceled). */
export class TopviewPredictionError extends ProviderError {
  constructor(public readonly prediction: Prediction) {
    const detail = prediction.error ? `: ${prediction.error.slice(0, DETAIL_MAX)}` : "";
    super(`TopView prediction ${prediction.id} ${prediction.status}${detail}`, PROVIDER);
    this.name = "TopviewPredictionError";
  }
}

/** The balance cannot cover the prediction; TopView settles it after a top-up. */
export class TopviewPaymentRequiredError extends ProviderError {
  constructor(public readonly prediction: Prediction) {
    const due = prediction.amountDueUsd ? ` amount due $${prediction.amountDueUsd}` : "";
    const short = prediction.shortfallUsd ? `, shortfall $${prediction.shortfallUsd}` : "";
    super(
      `TopView prediction ${prediction.id} needs payment:${due}${short}. Top up the same workspace at ${TOPVIEW_PLATFORM_DASHBOARD_LINK}; settlement retries automatically without resubmitting`,
      PROVIDER,
    );
    this.name = "TopviewPaymentRequiredError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** A USD amount as the exact decimal string TopView sends (numbers are stringified). */
function usd(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return value.trim();
  return undefined;
}

/** `{error:{code,message}}`, `{code,message}` or plain text from an error body. */
function errorParts(snippet: string): { code?: string; detail: string } {
  try {
    const body = record(JSON.parse(snippet));
    const inner = record(body?.error);
    const code = str(inner?.code) ?? (typeof body?.code === "string" ? body.code : undefined);
    const detail = str(inner?.message) ?? str(body?.message) ?? str(body?.error) ?? "";
    return { code, detail: detail.slice(0, DETAIL_MAX) };
  } catch {
    return { detail: snippet.trim().slice(0, DETAIL_MAX) };
  }
}

/** Map an HTTP failure to an actionable TopviewPlatformError; other errors pass through. */
export function mapPlatformError(error: unknown, subject: string): unknown {
  if (!(error instanceof HttpError)) return error;
  const { code, detail } = errorParts(error.snippet);
  const suffix = `${code ? ` [${code}]` : ""}${detail ? `: ${detail}` : ""}`;
  const { status, retryAfterMs } = error;
  let message: string;
  if (status === 0) {
    message = `Network error contacting the TopView API Platform${suffix}`;
  } else if (status === 401) {
    message = `TopView API Platform rejected the API key (401)${suffix}. Check TOPVIEW_PLATFORM_API_KEY (API keys at ${TOPVIEW_PLATFORM_DASHBOARD_LINK})`;
  } else if (status === 402) {
    message = `TopView API Platform balance is too low for ${subject} (402)${suffix}. Top up at ${TOPVIEW_PLATFORM_DASHBOARD_LINK}`;
  } else if (status === 403) {
    message = `TopView API Platform denied access to ${subject} (403)${suffix}. Check the key's permissions (models:generate, requests:read) and model allowlist`;
  } else if (status === 404) {
    message = `TopView API Platform could not find ${subject} (404)${suffix}. A new or rotated key cannot see tasks created by another key`;
  } else if (status === 429) {
    const wait =
      retryAfterMs !== undefined ? `; retry after ${Math.ceil(retryAfterMs / 1000)}s` : "";
    message = `TopView API Platform rate limit reached (429)${wait}`;
  } else if (status >= 500) {
    message = `TopView API Platform server error (${status})${suffix}. Try again later`;
  } else {
    message = `TopView API Platform rejected ${subject} (${status})${suffix}`;
  }
  return new TopviewPlatformError(message, status, code, retryAfterMs, { cause: error });
}

export function scrubSecret(error: unknown, secret: string): unknown {
  if (!(error instanceof HttpError) || !secret || !error.snippet.includes(secret)) return error;
  const snippet = error.snippet.split(secret).join("[redacted]");
  return new HttpError(error.status, snippet, error.rawUrl, error.retryAfterMs);
}

/** Read `{code:200, message, data}`; returns `data`. */
function unwrap(body: unknown, subject: string): Record<string, unknown> {
  const envelope = record(body);
  const code = envelope?.code;
  if (envelope && code !== undefined && String(code) !== "200") {
    const message = str(envelope.message)?.slice(0, DETAIL_MAX) ?? "";
    throw new TopviewPlatformError(
      `TopView API Platform rejected ${subject} (code ${String(code)})${message ? `: ${message}` : ""}`,
      200,
      String(code),
    );
  }
  const data = record(envelope?.data);
  if (!data) {
    throw new TopviewPlatformError(`Malformed TopView API Platform response for ${subject}`, 200);
  }
  return data;
}

/** Parse a prediction leniently; only the id and a status string are required. */
export function parsePrediction(data: Record<string, unknown>): Prediction {
  if (!isPredictionId(data.id)) {
    throw new TopviewPlatformError("Malformed TopView prediction: missing or invalid id", 200);
  }
  const status = str(data.status)?.trim().toLowerCase();
  if (!status) {
    throw new TopviewPlatformError(`Malformed TopView prediction ${data.id}: missing status`, 200);
  }
  const outputs = Array.isArray(data.outputs)
    ? data.outputs.filter(
        (o): o is string => typeof o === "string" && /^https?:\/\//i.test(o.trim()),
      )
    : [];
  const prediction: Prediction = { id: data.id, status, outputs: outputs.map((o) => o.trim()) };
  const createdAt = str(data.created_at);
  if (createdAt) prediction.createdAt = createdAt;
  const charged = usd(data.charged_usd);
  if (charged !== undefined) prediction.chargedUsd = charged;
  const billing = str(data.billing_state);
  if (billing) prediction.billingState = billing;
  const error = str(data.error) ?? str(record(data.error)?.message);
  if (error) prediction.error = error;
  const due = usd(data.amount_due_usd);
  if (due !== undefined) prediction.amountDueUsd = due;
  const additional = usd(data.additional_charge_usd);
  if (additional !== undefined) prediction.additionalChargeUsd = additional;
  const shortfall = usd(data.shortfall_usd);
  if (shortfall !== undefined) prediction.shortfallUsd = shortfall;
  return prediction;
}

/** Throw unless completed: failed/canceled and payment_required each get their own error. */
export function assertPredictionCompleted(prediction: Prediction): Prediction {
  if (prediction.status === "completed") return prediction;
  if (prediction.status === "payment_required") throw new TopviewPaymentRequiredError(prediction);
  if (isPredictionStopped(prediction.status)) throw new TopviewPredictionError(prediction);
  throw new ProviderError(
    `TopView prediction ${prediction.id} is not finished (status: ${prediction.status})`,
    PROVIDER,
  );
}

/** Submit failures worth retrying with the same Idempotency-Key. */
function isRetryableSubmit(error: unknown): boolean {
  return isTransientHttpError(error);
}

/** A failure after which the prediction may exist anyway. */
function isAmbiguous(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 0 || error.status === 408 || error.status >= 500 || error.status < 300;
  }
  return (
    error instanceof TopviewPlatformError && error.status === 200 && error.apiCode === undefined
  );
}

export interface PlatformClientOptions {
  apiKey: string;
  /** Defaults to https://platform-backend.topview.ai/api/v1. */
  baseUrl?: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export interface PlatformWaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  maxIntervalMs?: number;
  resumeHint?: string;
  onPoll?: (prediction: Prediction, attempt: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/** Idempotency keys go in a header: printable ASCII without spaces, bounded length. */
export function isValidIdempotencyKey(key: string): boolean {
  return /^[A-Za-z0-9._:-]{8,128}$/.test(key);
}

export class TopviewPlatformClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: PlatformClientOptions) {
    if (!opts.apiKey) throw new ProviderError("TopView API Platform key is required", PROVIDER);
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_TOPVIEW_PLATFORM_BASE_URL).replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private raw(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    return fetchJson<unknown>({
      url: `${this.baseUrl}${path}`,
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...extraHeaders,
      },
      body,
      timeoutMs,
      fetch: this.doFetch,
    }).catch((error: unknown) => {
      throw scrubSecret(error, this.apiKey);
    });
  }

  /**
   * Validate and submit one prediction. The same key and body are re-sent on
   * a retryable failure; when the retries run out on an ambiguous failure the
   * error carries the key so the caller can retry safely later.
   */
  async submit(
    spec: PlatformModel,
    body: Record<string, unknown>,
    idempotencyKey: string,
    maxRetries = SUBMIT_MAX_RETRIES,
  ): Promise<Prediction> {
    if (!isValidIdempotencyKey(idempotencyKey)) {
      throw new ProviderError(
        "Idempotency key must be 8-128 characters of letters, digits, '.', '_', ':' or '-'",
        PROVIDER,
      );
    }
    validatePlatformBody(spec, body);
    const subject = `model ${spec.id}`;
    const path = `/models/${spec.vendor}/${spec.model}/${spec.mode}/predictions`;
    for (let attempt = 0; ; attempt++) {
      try {
        const data = unwrap(
          await this.raw(path, "POST", body, { "idempotency-key": idempotencyKey }),
          subject,
        );
        return parsePrediction(data);
      } catch (error) {
        if (isRetryableSubmit(error) && attempt < maxRetries) {
          const retryAfter = error instanceof HttpError ? error.retryAfterMs : undefined;
          await this.sleep(
            Math.min(retryAfter ?? SUBMIT_RETRY_BASE_MS * 2 ** attempt, SUBMIT_RETRY_CAP_MS),
          );
          continue;
        }
        const mapped = mapPlatformError(error, subject);
        if (isAmbiguous(error)) {
          const message = mapped instanceof Error ? mapped.message : String(mapped);
          throw new TopviewAmbiguousSubmitError(
            `${message}. The prediction may have been created; retry with the same Idempotency-Key (${idempotencyKey}) and the same request to avoid paying twice`,
            idempotencyKey,
            { cause: mapped },
          );
        }
        throw mapped;
      }
    }
  }

  async getPrediction(id: string): Promise<Prediction> {
    const safeId = assertPredictionId(id);
    try {
      return parsePrediction(
        unwrap(await this.raw(`/predictions/${safeId}`, "GET"), `prediction ${safeId}`),
      );
    } catch (error) {
      throw mapPlatformError(error, `prediction ${safeId}`);
    }
  }

  /**
   * Poll until completed, failed or payment_required and return the
   * prediction — callers decide success. Retries network/408/429/5xx
   * (honouring Retry-After); throws PollTimeoutError on the deadline.
   */
  async waitForPrediction(id: string, opts: PlatformWaitOptions): Promise<Prediction> {
    const safeId = assertPredictionId(id);
    try {
      return await pollUntil<Prediction>({
        fetchStatus: async ({ remainingMs }) =>
          parsePrediction(
            unwrap(
              await this.raw(
                `/predictions/${safeId}`,
                "GET",
                undefined,
                {},
                Math.max(1, Math.ceil(Math.min(REQUEST_TIMEOUT_MS, remainingMs))),
              ),
              `prediction ${safeId}`,
            ),
          ),
        isTerminal: (p) => isPredictionStopped(p.status),
        isTransientError: isTransientHttpError,
        timeoutMs: opts.timeoutMs,
        intervalMs: opts.intervalMs ?? PLATFORM_POLL_INTERVAL_MS,
        maxIntervalMs: opts.maxIntervalMs ?? PLATFORM_POLL_MAX_INTERVAL_MS,
        backoffFactor: 1.25,
        minIntervalMs: 1_000,
        jitter: false,
        resumeHint: opts.resumeHint,
        onPoll: opts.onPoll,
        sleep: opts.sleep ?? this.sleep,
        now: opts.now,
      });
    } catch (error) {
      if (error instanceof PollTimeoutError) throw error;
      throw mapPlatformError(error, `prediction ${safeId}`);
    }
  }

  /** POST /media/files: upload one file (at most 20 MiB) and return its signed download URL. */
  async uploadMedia(opts: {
    data: Blob;
    filename: string;
    kind: "image" | "video" | "audio";
  }): Promise<MediaAsset> {
    const subject = `upload of ${opts.filename}`;
    if (opts.data.size > MEDIA_MAX_BYTES) {
      throw new ProviderError(
        `${opts.filename} is larger than the 20 MiB TopView API Platform upload limit`,
        PROVIDER,
      );
    }
    const url = `${this.baseUrl}/media/files`;
    const form = new FormData();
    form.append("kind", opts.kind);
    form.append("file", opts.data, opts.filename);
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: "POST",
        headers: { accept: "application/json", authorization: `Bearer ${this.apiKey}` },
        body: form,
        // The key travels in a header: never follow a redirect with it.
        redirect: "manual",
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch (cause) {
      throw mapPlatformError(toFetchError(cause, url, { provider: PROVIDER }), subject);
    }
    if (!response.ok) {
      throw mapPlatformError(
        scrubSecret(await httpErrorFromResponse(response, url), this.apiKey),
        subject,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TopviewPlatformError(`Malformed TopView API Platform response for ${subject}`, 200);
    }
    const data = unwrap(body, subject);
    const downloadUrl = str(data.download_url);
    const id = str(data.id);
    if (!id || !downloadUrl) {
      throw new TopviewPlatformError(`Malformed TopView media response for ${subject}`, 200);
    }
    checkUrlSafety(downloadUrl, { provider: PROVIDER, action: "use" });
    const asset: MediaAsset = { id, downloadUrl };
    const reference = str(data.reference);
    if (reference) asset.reference = reference;
    return asset;
  }
}
