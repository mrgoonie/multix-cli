/**
 * TopView API Platform client (https://platform-backend.topview.ai,
 * platform.topview.ai/docs). A separate product from the Legacy API: its own
 * key (TOPVIEW_PLATFORM_API_KEY) and its own USD balance per workspace.
 *
 * Runtime-neutral: no node:* imports, no env/logger/disk access. Callers pass
 * `apiKey`, optional `baseUrl` and optional `fetch`.
 *
 * - Submit: POST /api/v1/models/{provider}/{model}/{mode}/predictions with an
 *   Idempotency-Key. Network errors, 429 and 5xx are retried (at most twice)
 *   with the SAME key and the same body, so a retry can never create a second
 *   task; a new key is never generated for the same submission.
 * - Poll: GET /api/v1/predictions/{id} (created | processing |
 *   payment_required | completed | failed).
 * - Catalog: GET /platform/v1/models is public; it is read without the key.
 */

import { PollTimeoutError, isRetryableServerStatus, pollUntil } from "../../core/async-poll.js";
import { HttpError, ProviderError } from "../../core/errors.js";
import { type FetchLike, fetchJson } from "../../core/fetch-json.js";
import {
  PROVIDER,
  TopviewApiError,
  mapPlatformError,
  platformErrorBody,
  platformErrorMessage,
  scrubSecret,
} from "./errors.js";
import {
  DEFAULT_TOPVIEW_PLATFORM_BASE_URL,
  PLATFORM_CATALOG_PATH,
  assertBodyFamily,
  assertIdempotencyKey,
  assertPlatformRoute,
  assertPredictionId,
  isPlatformTerminalStatus,
  isValidPredictionId,
} from "./models.js";
import type { PlatformCatalogModel, PlatformOfferPrice, PlatformPrediction } from "./types.js";

const REQUEST_TIMEOUT_MS = 120_000;
const SUBMIT_MAX_RETRIES = 2;
const SUBMIT_RETRY_CAP_MS = 30_000;
/** The docs ask for polling every 2-5 seconds with back-off. */
const MIN_POLL_INTERVAL_MS = 2_000;
const CATALOG_MAX_BYTES = 2_000_000;

type Json = Record<string, unknown>;

export interface TopviewPlatformClientOptions {
  apiKey: string;
  /** Defaults to https://platform-backend.topview.ai. */
  baseUrl?: string;
  fetch?: FetchLike;
  /** Injectable for tests (retry back-off). */
  sleep?: (ms: number) => Promise<void>;
  /** Idempotency-key generator. Default globalThis.crypto.randomUUID(). */
  newIdempotencyKey?: () => string;
}

export interface PlatformWaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  maxIntervalMs?: number;
  resumeHint?: string;
  onPoll?: (p: PlatformPrediction, attempt: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface PlatformSubmitResult {
  prediction: PlatformPrediction;
  /** The key the submission used; reuse it to retry the same submission safely. */
  idempotencyKey: string;
}

export interface PlatformCatalog {
  models: PlatformCatalogModel[];
  /** True when the catalog reported another page (not fetched). */
  truncated: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function asRecord(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function optString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value.slice(0, 200);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function malformed(what: string): ProviderError {
  return new ProviderError(`Malformed TopView API Platform response: ${what}`, PROVIDER);
}

/** Validate a prediction (`data`); unknown statuses are kept and treated as not finished. */
export function validatePrediction(value: unknown): PlatformPrediction {
  const d = asRecord(value);
  if (!d || !isValidPredictionId(d.id)) throw malformed("missing or invalid prediction id");
  if (typeof d.status !== "string" || d.status.trim() === "") {
    throw malformed(`prediction ${d.id} without a status`);
  }
  if (d.outputs !== undefined && d.outputs !== null && !Array.isArray(d.outputs)) {
    throw malformed(`prediction ${d.id} outputs is not a list`);
  }
  const outputs = Array.isArray(d.outputs)
    ? d.outputs.filter((o): o is string => typeof o === "string" && o.length > 0)
    : [];
  const p: PlatformPrediction = { id: d.id, status: d.status.trim(), outputs };
  if (typeof d.created_at === "string") p.created_at = d.created_at.slice(0, 40);
  if (typeof d.code === "number") p.code = d.code;
  for (const key of [
    "charged_usd",
    "billing_state",
    "amount_due_usd",
    "additional_charge_usd",
    "shortfall_usd",
    "error",
    "last_frame_url",
  ] as const) {
    const v = optString(d[key]);
    if (v !== undefined) p[key] = v;
  }
  return p;
}

/** Unwrap `{ code: 200, data }`; any other code is an error even on HTTP 200. */
function unwrapPlatform(json: unknown, subject: string): unknown {
  const body = asRecord(json);
  if (!body) throw malformed(`empty body for ${subject}`);
  if (body.code === 200 || body.code === "200") return body.data;
  const info = platformErrorBody(body);
  const status = typeof body.code === "number" ? body.code : 200;
  throw new TopviewApiError(platformErrorMessage(status, info, subject), status, info.code);
}

/** Network errors, 429 and retryable 5xx: the submission may be retried with the same key. */
function isRetryableSubmitError(error: unknown): error is HttpError {
  return (
    error instanceof HttpError && (error.status === 429 || isRetryableServerStatus(error.status))
  );
}

function catalogOffer(value: unknown): PlatformOfferPrice | undefined {
  const o = asRecord(value);
  const price = asRecord(o?.price);
  if (!o || !price) return undefined;
  const spec: PlatformOfferPrice["spec"] = {};
  for (const [k, v] of Object.entries(asRecord(o.spec) ?? {})) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") spec[k] = v;
  }
  const out: PlatformOfferPrice = { spec };
  for (const key of [
    "componentCode",
    "meter",
    "unit",
    "unitSize",
    "saleUnitUsd",
    "referenceAsOf",
  ] as const) {
    const v = optString(price[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Parse the public catalog body `{ data: { items, nextCursor } }`. */
export function parseCatalog(json: unknown): PlatformCatalog {
  const data = asRecord(asRecord(json)?.data);
  if (!data || !Array.isArray(data.items)) throw malformed("model catalog without data.items");
  const models: PlatformCatalogModel[] = [];
  for (const item of data.items) {
    const m = asRecord(item);
    if (!m || typeof m.displayName !== "string" || !m.displayName) continue;
    const offers = Array.isArray(m.offers)
      ? m.offers.map(catalogOffer).filter((o): o is PlatformOfferPrice => o !== undefined)
      : [];
    models.push({
      displayName: m.displayName.slice(0, 100),
      ...(optString(m.category) ? { category: optString(m.category) } : {}),
      ...(optString(m.manufacturer) ? { manufacturer: optString(m.manufacturer) } : {}),
      offers,
    });
  }
  return { models, truncated: typeof data.nextCursor === "string" && data.nextCursor !== "" };
}

export class TopviewPlatformClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newKey: () => string;

  constructor(opts: TopviewPlatformClientOptions) {
    if (!opts.apiKey?.trim()) {
      throw new ProviderError("TopView API Platform key is required", PROVIDER);
    }
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl || DEFAULT_TOPVIEW_PLATFORM_BASE_URL).replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.newKey = opts.newIdempotencyKey ?? (() => globalThis.crypto.randomUUID());
  }

  private raw(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<unknown> {
    return fetchJson<unknown>({
      url: `${this.baseUrl}${path}`,
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...opts.headers,
      },
      body: opts.body,
      timeoutMs: opts.timeoutMs ?? REQUEST_TIMEOUT_MS,
      fetch: this.doFetch,
    }).catch((error: unknown) => {
      throw scrubSecret(error, this.apiKey);
    });
  }

  /**
   * Submit a prediction on a verified route. The route and the body's
   * top-level shape are checked before any request. Pass `idempotencyKey` to
   * retry an earlier submission whose outcome is unknown (same key, same
   * body); otherwise a fresh key is generated once and reused for retries.
   */
  async submit(
    route: string,
    body: Json,
    opts: { idempotencyKey?: string } = {},
  ): Promise<PlatformSubmitResult> {
    const spec = assertPlatformRoute(route);
    assertBodyFamily(spec, body);
    const idempotencyKey = opts.idempotencyKey
      ? assertIdempotencyKey(opts.idempotencyKey)
      : this.newKey();
    const subject = `route ${spec.route}`;
    const path = `/api/v1/models/${spec.route}/predictions`;
    for (let attempt = 0; ; attempt++) {
      try {
        const json = await this.raw("POST", path, {
          body,
          headers: { "Idempotency-Key": idempotencyKey },
        });
        return { prediction: validatePrediction(unwrapPlatform(json, subject)), idempotencyKey };
      } catch (error) {
        if (isRetryableSubmitError(error) && attempt < SUBMIT_MAX_RETRIES) {
          const delay = Math.min(error.retryAfterMs ?? 2000 * (attempt + 1), SUBMIT_RETRY_CAP_MS);
          await this.sleep(delay);
          continue;
        }
        throw withPlatformOrphanHint(mapPlatformError(error, subject), spec.route, idempotencyKey);
      }
    }
  }

  async getPrediction(id: string): Promise<PlatformPrediction> {
    const safeId = assertPredictionId(id);
    const subject = `prediction ${safeId}`;
    try {
      return validatePrediction(
        unwrapPlatform(await this.raw("GET", `/api/v1/predictions/${safeId}`), subject),
      );
    } catch (error) {
      throw mapPlatformError(error, subject);
    }
  }

  /**
   * Poll until completed, failed or payment_required and return the
   * prediction; callers decide success. Retries network/408/429/5xx
   * (honouring Retry-After); throws PollTimeoutError on deadline.
   */
  async waitForPrediction(id: string, opts: PlatformWaitOptions): Promise<PlatformPrediction> {
    const safeId = assertPredictionId(id);
    const subject = `prediction ${safeId}`;
    try {
      return await pollUntil<PlatformPrediction>({
        fetchStatus: async ({ remainingMs }) =>
          validatePrediction(
            unwrapPlatform(
              await this.raw("GET", `/api/v1/predictions/${safeId}`, {
                timeoutMs: Math.max(1, Math.ceil(Math.min(REQUEST_TIMEOUT_MS, remainingMs))),
              }),
              subject,
            ),
          ),
        isTerminal: (p) => isPlatformTerminalStatus(p.status),
        timeoutMs: opts.timeoutMs,
        intervalMs: Math.max(MIN_POLL_INTERVAL_MS, opts.intervalMs ?? MIN_POLL_INTERVAL_MS),
        maxIntervalMs: opts.maxIntervalMs ?? 15_000,
        backoffFactor: 1.25,
        minIntervalMs: MIN_POLL_INTERVAL_MS,
        jitter: false,
        resumeHint: opts.resumeHint,
        onPoll: opts.onPoll,
        sleep: opts.sleep ?? this.sleep,
        now: opts.now,
      });
    } catch (error) {
      if (error instanceof PollTimeoutError) throw error;
      throw mapPlatformError(error, subject);
    }
  }
}

/**
 * Read the public model and price catalog. Sends no API key (the endpoint is
 * public), so it works before any key is configured.
 */
export async function fetchPlatformCatalog(opts: {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<PlatformCatalog> {
  const base = (opts.baseUrl || DEFAULT_TOPVIEW_PLATFORM_BASE_URL).replace(/\/+$/, "");
  try {
    const json = await fetchJson<unknown>({
      url: `${base}${PLATFORM_CATALOG_PATH}`,
      headers: { accept: "application/json" },
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxBytes: CATALOG_MAX_BYTES,
      fetch: opts.fetch,
    });
    return parseCatalog(json);
  } catch (error) {
    throw mapPlatformError(error, "the model catalog");
  }
}

/**
 * Network errors, 5xx and unusable 2xx bodies on submit may come after the
 * prediction was created (with funds reserved). The same Idempotency-Key and
 * body make a retry safe; say so instead of letting the user resubmit blind.
 */
export function platformOrphanHint(route: string, key: string): string {
  return `The prediction may have been created anyway. Retry the SAME submission safely with the same body and key: multix topview run ${route} --input <same input> --idempotency-key ${key}`;
}

function withPlatformOrphanHint(error: unknown, route: string, key: string): unknown {
  const hint = platformOrphanHint(route, key);
  if (error instanceof TopviewApiError) {
    const { status } = error;
    if (!(status === 0 || isRetryableServerStatus(status))) return error;
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
