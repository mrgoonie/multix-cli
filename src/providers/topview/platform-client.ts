/**
 * TopView API Platform client (pay-as-you-go USD balance, separate from the
 * topview.ai web plan). Runtime-neutral: no node:* imports.
 *
 * API contract (https://platform.topview.ai/llms-full.txt):
 * - Auth: `Authorization: Bearer <TOPVIEW_API_PLATFORM_KEY>`
 * - Submit: POST /api/v1/models/{owner}/{model}/{mode}/predictions with the
 *   model's native JSON body and an `Idempotency-Key` header -> data.id
 * - Poll: GET /api/v1/predictions/{id} (original creating key only) ->
 *   data.status created | processing | payment_required | completed | failed,
 *   data.outputs[], data.charged_usd (decimal string), data.billing_state
 * - Assets: POST /api/v1/media/files (multipart kind + file, 20 MiB max)
 * "The estimated price is not a cap", and no cancel endpoint is documented.
 */

import { isTransientHttpError, pollUntil } from "../../core/async-poll.js";
import { ConfigError, ProviderError, ValidationError } from "../../core/errors.js";
import { DEFAULT_TIMEOUT_MS, type FetchLike, fetchJson } from "../../core/fetch-json.js";
import {
  DEFAULT_TOPVIEW_PLATFORM_BASE_URL,
  PLATFORM_MAX_UPLOAD_BYTES,
  type PlatformRoute,
  TOPVIEW_PROVIDER,
  routeId,
} from "./models.js";
import { parseJson, sendOnce, unknownRemoteState } from "./send-once.js";
import type {
  PlatformAsset,
  PlatformClientOptions,
  PlatformEnvelope,
  PlatformPrediction,
  WaitOptions,
} from "./types.js";

const PREDICTION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const UPLOAD_TIMEOUT_MS = 300_000;

export function assertValidPredictionId(id: string): void {
  if (!PREDICTION_ID_RE.test(id)) {
    throw new ValidationError(`Invalid TopView Platform task id: "${id}"`);
  }
}

export function assertValidIdempotencyKey(key: string): void {
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw new ValidationError(
      "--idempotency-key must be 8-128 characters of letters, digits, '_', '-', '.' or ':'",
    );
  }
}

/** completed and failed end polling; payment_required settles by itself after a top-up. */
export function isPlatformTerminal(status: unknown): boolean {
  return status === "completed" || status === "failed";
}

export class TopviewPlatformFailedError extends ProviderError {
  constructor(public readonly prediction: PlatformPrediction) {
    super(
      `TopView Platform task failed (${prediction.id}): ${prediction.error || `status "${prediction.status}"`}`,
      TOPVIEW_PROVIDER,
    );
    this.name = "TopviewPlatformFailedError";
  }
}

/** The Platform error body: `{ error: { code, message, retryable }, code, message }`. */
export function platformErrorMessage(text: string): string {
  const body = parseJson(text) as
    | { error?: { code?: unknown; message?: unknown }; message?: unknown }
    | undefined;
  if (body && typeof body === "object") {
    const err = body.error;
    if (err && typeof err === "object" && typeof err.message === "string") {
      return typeof err.code === "string" ? `${err.message} (${err.code})` : err.message;
    }
    if (typeof body.message === "string") return body.message;
  }
  return text;
}

function isPlatformError(text: string): boolean {
  const body = parseJson(text) as { error?: unknown; message?: unknown } | undefined;
  return Boolean(body && typeof body === "object" && (body.error || body.message));
}

function predictionData(
  env: PlatformEnvelope<PlatformPrediction> | undefined,
): PlatformPrediction | undefined {
  const data = env && typeof env === "object" ? env.data : undefined;
  if (!data || typeof data !== "object") return undefined;
  if (typeof data.id !== "string" || typeof data.status !== "string") return undefined;
  return data;
}

export class TopviewPlatformClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: PlatformClientOptions) {
    if (!opts.apiKey?.trim()) throw new ConfigError("TOPVIEW_API_PLATFORM_KEY is not set");
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl?.trim() || DEFAULT_TOPVIEW_PLATFORM_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
  }

  /**
   * Create a prediction once. The Platform documents Idempotency-Key: after an
   * unknown outcome the same key with the same body returns the original task
   * instead of a second one, so the error names the key to reuse.
   */
  async createPrediction(
    route: PlatformRoute,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<PlatformPrediction> {
    assertValidIdempotencyKey(idempotencyKey);
    const id = routeId(route);
    const url = `${this.baseUrl}/api/v1/models/${id}/predictions`;
    const what = `${id} submit`;
    const advice = `resend the same input with --idempotency-key ${idempotencyKey} (the Platform then returns the original task instead of creating another), or check the task history on platform.topview.ai.`;
    const text = await sendOnce({
      url,
      what,
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
      timeoutMs: this.timeoutMs,
      advice,
      isProviderError: isPlatformError,
      errorMessage: platformErrorMessage,
      fetch: this.fetchImpl,
    });
    const data = predictionData(parseJson(text) as PlatformEnvelope<PlatformPrediction>);
    if (!data || !PREDICTION_ID_RE.test(data.id)) {
      throw unknownRemoteState(what, "the response carries no task id", advice);
    }
    return data;
  }

  /** Read a prediction once. */
  async getPrediction(id: string, timeoutMs?: number): Promise<PlatformPrediction> {
    assertValidPredictionId(id);
    const env = await fetchJson<PlatformEnvelope<PlatformPrediction>>({
      url: `${this.baseUrl}/api/v1/predictions/${id}`,
      headers: this.headers(),
      timeoutMs: timeoutMs ?? this.timeoutMs,
      fetch: this.fetchImpl,
    });
    const data = predictionData(env);
    if (!data) {
      throw new ProviderError(
        `TopView Platform task ${id}: response has no data.id/data.status (schema mismatch)`,
        TOPVIEW_PROVIDER,
      );
    }
    return data;
  }

  /** Poll until completed or failed; 429 (Retry-After), 5xx and network errors are retried. */
  waitForPrediction(
    id: string,
    opts: WaitOptions<PlatformPrediction>,
  ): Promise<PlatformPrediction> {
    assertValidPredictionId(id);
    return pollUntil<PlatformPrediction>({
      fetchStatus: ({ remainingMs }) =>
        this.getPrediction(id, Math.ceil(Math.max(1000, Math.min(this.timeoutMs, remainingMs)))),
      isTerminal: (p) => isPlatformTerminal(p.status),
      timeoutMs: opts.timeoutMs,
      intervalMs: opts.intervalMs ?? 3000,
      maxIntervalMs: opts.maxIntervalMs ?? 15_000,
      isTransientError: isTransientHttpError,
      onPoll: opts.onPoll,
      resumeHint: opts.resumeHint,
      sleep: opts.sleep,
      now: opts.now,
    });
  }

  /**
   * Upload a reference file as a workspace asset. Sent once: each upload
   * counts against the 24 h upload allowance.
   */
  async uploadAsset(
    file: Blob,
    filename: string,
    kind: "image" | "video" | "audio",
  ): Promise<PlatformAsset> {
    if (file.size > PLATFORM_MAX_UPLOAD_BYTES) {
      throw new ValidationError(`${filename} is larger than the Platform's 20 MiB asset limit`);
    }
    const form = new FormData();
    form.append("kind", kind);
    form.append("file", file, filename);
    const url = `${this.baseUrl}/api/v1/media/files`;
    const what = "asset upload";
    const advice = "check Assets on platform.topview.ai before uploading again.";
    const text = await sendOnce({
      url,
      what,
      headers: this.headers(),
      body: form,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      advice,
      isProviderError: isPlatformError,
      errorMessage: platformErrorMessage,
      fetch: this.fetchImpl,
    });
    const data = (parseJson(text) as PlatformEnvelope<PlatformAsset> | undefined)?.data;
    if (!data || typeof data.id !== "string" || !data.id) {
      throw unknownRemoteState(what, "the response carries no asset id", advice);
    }
    return data;
  }
}
