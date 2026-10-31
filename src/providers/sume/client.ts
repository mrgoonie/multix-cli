/**
 * Direct Sume API client (https://api.sume.com).
 *
 * Runtime-neutral: no node:* imports, no env/logger/disk access. Callers pass
 * `apiKey`, optional `baseUrl`, and optional `fetch`, so the same client runs
 * in the Node CLI and in non-Node runtimes such as a Cloudflare Worker.
 *
 * - Catalog (public, no key): GET /v1/open/catalog[/{id}]
 * - Submit: POST /v1/image-router/generate | /v1/video-router/generate with an
 *   Idempotency-Key, so a retry of the same body returns the same job and is
 *   charged once. Network errors, timeouts, 429 and 5xx are retried with the
 *   same key; a key is never replaced by a new one.
 * - Jobs: GET /v1/jobs/{id}/status, /result, /v1/jobs/{id}; POST .../cancel
 * - Inputs: POST /v1/files/generate-upload-url, then PUT the bytes (no key)
 * - Account: GET /v1/open/balance; quote: POST /v1/open/estimate
 *
 * Sends exactly one credential header (Authorization: Bearer); Sume refuses a
 * request that carries both it and x-api-key.
 */

import { PollTimeoutError, isTransientHttpError } from "../../core/async-poll.js";
import { HttpError, ProviderError, ProviderJobFailedError } from "../../core/errors.js";
import { toFetchError } from "../../core/fetch-error.js";
import { type FetchLike, fetchJson, httpErrorFromResponse } from "../../core/fetch-json.js";
import { checkUrlSafety } from "../../core/url-safety.js";
import {
  DEFAULT_SUME_BASE_URL,
  MIN_POLL_INTERVAL_MS,
  SUME_CATALOG_PATH,
  SUME_DASHBOARD_LINK,
  SUME_ROUTING,
  assertIdempotencyKey,
  assertJobId,
  assertModelId,
  clean,
  isTerminalStatus,
  isValidJobId,
  normalizeStatus,
  parseCatalog,
  parseCatalogModel,
} from "./models.js";
import type {
  SumeArtifact,
  SumeBalance,
  SumeCancelResult,
  SumeCatalog,
  SumeJob,
  SumeJobStatus,
  SumeModel,
  SumeSubmitted,
  SumeUploadTicket,
} from "./types.js";

const PROVIDER = "sume";
const DETAIL_MAX = 300;
const SUBMIT_MAX_RETRIES = 2;
const SUBMIT_RETRY_CAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;
const CATALOG_MAX_BYTES = 10_000_000;
const UPLOAD_BASE_TIMEOUT_MS = 60_000;
/** Slowest uplink an upload allows for before timing out (1 MB/s). */
const DEFAULT_MIN_UPLOAD_BYTES_PER_SEC = 1_000_000;
const POLL_MAX_INTERVAL_MS = 30_000;
const KEY_ENV = SUME_ROUTING.keyEnvs[0];

/** Parsed `{error:{...}}` body of a Sume error response. */
export interface SumeErrorBody {
  code?: string;
  message?: string;
  requestId?: string;
  nextAction?: string;
  details?: Record<string, unknown>;
}

/** Sume API error with an actionable message; keeps status and Sume's code for programmatic use. */
export class SumeApiError extends ProviderError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly sumeCode?: string,
    public readonly retryAfterMs?: number,
    public readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, PROVIDER, options);
    this.name = "SumeApiError";
  }
}

/** A job ended failed or canceled — never a success. */
export class SumeJobError extends ProviderJobFailedError {
  constructor(
    public readonly jobId: string,
    public readonly status: string,
    public readonly reason?: { code?: string; message?: string; publicReason?: string },
  ) {
    const code = reason?.code ? ` [${reason.code}]` : "";
    const why = reason?.message ? `: ${reason.message.slice(0, DETAIL_MAX)}` : "";
    const refund =
      status === "failed" || status === "canceled"
        ? ". Sume refunds the reserved charge of failed and canceled jobs"
        : "";
    super(`Sume job ${jobId} ${status}${code}${why}${refund}`, PROVIDER, {
      terminal: status === "failed",
    });
    this.name = "SumeJobError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, max = DETAIL_MAX): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = clean(value).trim().slice(0, max);
  return s || undefined;
}

/** `{error:{code,message,...}}` from an error snippet; undefined when it is not one. */
export function parseErrorBody(snippet: string): SumeErrorBody | undefined {
  try {
    const error = record(record(JSON.parse(snippet))?.error);
    if (!error) return undefined;
    return {
      code: text(error.code, 80),
      message: text(error.message),
      requestId: text(error.request_id, 128),
      nextAction: text(error.next_action, 80),
      details: record(error.details),
    };
  } catch {
    return undefined;
  }
}

function money(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return `$${value}`;
  const s = text(value, 40);
  return s && /^\d+(\.\d+)?$/.test(s) ? `$${s}` : undefined;
}

/**
 * Map an HTTP failure to an actionable message. `subject` names what was
 * requested (a model, a job, an upload) so the hint points at the right fix.
 */
export function mapSumeError(error: unknown, subject: string): unknown {
  if (!(error instanceof HttpError)) return error;
  const { status, retryAfterMs } = error;
  const body = parseErrorBody(error.snippet);
  const code = body?.code;
  const detail = body?.message ?? (body ? undefined : text(error.snippet));
  const suffix = `${code ? ` ${code}` : ""}${detail ? `: ${detail}` : ""}`;
  const d = body?.details ?? {};
  const wait = retryAfterMs !== undefined ? `; retry after ${Math.ceil(retryAfterMs / 1000)}s` : "";
  let message: string;
  if (status === 0) {
    message = `Network error contacting Sume${detail ? `: ${detail}` : ""}`;
  } else if (status === 401) {
    message = `Sume rejected the API key (401${suffix}). Check ${KEY_ENV}; create a key at ${SUME_DASHBOARD_LINK} (Dashboard → API keys)`;
  } else if (status === 402) {
    const need = money(d.required_usd);
    const have = money(d.available_usd);
    const amounts = need ? ` (needs ${need}${have ? `, balance ${have}` : ""})` : "";
    message = `Sume balance is too low for ${subject}${amounts} (402${code ? ` ${code}` : ""}). Nothing was charged; add funds at ${SUME_DASHBOARD_LINK}`;
  } else if (status === 403 && code === "api_key_spend_limit_exceeded") {
    const limit = money(d.limit_usd);
    message = `Sume API key spend limit reached for ${subject}${limit ? ` (limit ${limit})` : ""} (403 ${code}). Nothing was charged; raise the limit at ${SUME_DASHBOARD_LINK}`;
  } else if (status === 403) {
    message = `Sume denied access to ${subject} (403${suffix})`;
  } else if (status === 404) {
    message = `Sume could not find ${subject} (404${suffix})`;
  } else if (status === 409 && code === "idempotency_conflict") {
    const jobId = isValidJobId(d.job_id) ? d.job_id : undefined;
    message = `Sume refused ${subject}: this Idempotency-Key was already used for a different request (409 ${code})${jobId ? `; it belongs to job ${jobId} (multix sume status ${jobId})` : ""}. Use a new key only if you want a second, separately billed job`;
  } else if (status === 409) {
    message = `Sume refused ${subject} (409${suffix})`;
  } else if (status === 400 || status === 413 || status === 415 || status === 422) {
    message = `Sume rejected the request for ${subject} (${status}${suffix}). Nothing was charged`;
  } else if (status === 429) {
    const what = code === "queue_full" ? "Sume job queue is full" : "Sume rate limit reached";
    message = `${what} (429${code ? ` ${code}` : ""})${wait}. Nothing was charged`;
  } else if (status >= 500) {
    message = `Sume server error (${status}${suffix}). Try again later`;
  } else {
    message = `Sume request for ${subject} failed (${status}${suffix})`;
  }
  if (body?.requestId) message += ` [request ${body.requestId}]`;
  return new SumeApiError(message, status, code, retryAfterMs, body?.details, { cause: error });
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

/** A 2xx body multix cannot use: on submit it may still name a created job. */
export class SumeMalformedResponseError extends ProviderError {
  constructor(what: string) {
    super(`Malformed Sume response: ${what}`, PROVIDER);
    this.name = "SumeMalformedResponseError";
  }
}

/** True when a failed submit may still have created (and reserved) a job. */
function mayHaveCreated(error: unknown): boolean {
  if (error instanceof SumeMalformedResponseError) return true;
  if (error instanceof SumeApiError || error instanceof HttpError) {
    const { status } = error;
    return status === 0 || status === 408 || status >= 500;
  }
  return false;
}

/** The orphan hint: how to get a possibly created job back without paying twice. */
export function orphanHint(idempotencyKey: string): string {
  return `Sume may have accepted (and reserved the charge for) a job anyway. Re-run the same command with --idempotency-key "${idempotencyKey}" to get that job back without paying twice, or check your jobs at ${SUME_DASHBOARD_LINK}`;
}

function withOrphanHint(error: unknown, key: string): unknown {
  if (!mayHaveCreated(error)) return error;
  const e = error as ProviderError;
  if (e instanceof SumeApiError) {
    return new SumeApiError(
      `${e.message}. ${orphanHint(key)}`,
      e.status,
      e.sumeCode,
      e.retryAfterMs,
      e.details,
      { cause: e.cause },
    );
  }
  return new ProviderError(`${e.message}. ${orphanHint(key)}`, PROVIDER, { cause: e.cause });
}

function unwrap(body: unknown, what: string): Record<string, unknown> {
  const data = record(record(body)?.data);
  if (!data) throw new SumeMalformedResponseError(`${what} has no data object`);
  return data;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The job id a response names (data.job_id, data.request_id, data.job.id), validated. */
function jobIdOf(data: Record<string, unknown>): string | undefined {
  for (const candidate of [data.job_id, record(data.job)?.id, data.request_id]) {
    if (isValidJobId(candidate)) return candidate;
  }
  return undefined;
}

/** Status from `sume_status`, `job.status` or `status` (unknown strings pass, never terminal). */
function statusOf(data: Record<string, unknown>): string | undefined {
  return (
    normalizeStatus(data.sume_status) ??
    normalizeStatus(record(data.job)?.status) ??
    normalizeStatus(data.status)
  );
}

export function parseSubmitted(body: unknown, idempotencyKey: string): SumeSubmitted {
  const data = unwrap(body, "submit response");
  const jobId = jobIdOf(data);
  if (!jobId) throw new SumeMalformedResponseError("submit response has no valid job id");
  const status = statusOf(data) ?? "queued";
  const usage = record(data.usage);
  const usd = typeof usage?.usd === "string" && /^\d+(\.\d+)?$/.test(usage.usd) ? usage.usd : "";
  const next = nonNegative(data.next_poll_after_seconds);
  return {
    jobId,
    status,
    terminal: data.terminal === true || isTerminalStatus(status),
    cancelable: data.cancelable === true,
    idempotencyHit: data.idempotency_hit === true,
    idempotencyKey,
    ...(next !== undefined ? { nextPollAfterSeconds: next } : {}),
    ...(usd ? { usageUsd: usd } : {}),
  };
}

export function parseStatus(body: unknown, requested: string): SumeJobStatus {
  const data = unwrap(body, "status response");
  const jobId = jobIdOf(data) ?? requested;
  if (jobId !== requested) {
    throw new SumeMalformedResponseError(`status response names job ${jobId}, not ${requested}`);
  }
  const status = statusOf(data);
  if (!status) throw new SumeMalformedResponseError("status response has no status");
  const next = nonNegative(data.next_poll_after_seconds);
  const queue = record(data.queue);
  const position = nonNegative(data.queue_position) ?? nonNegative(queue?.position);
  return {
    jobId,
    status,
    terminal: data.terminal === true || isTerminalStatus(status),
    resultReady: data.result_ready === true,
    cancelable: data.cancelable === true,
    ...(next !== undefined ? { nextPollAfterSeconds: next } : {}),
    ...(position !== undefined ? { queuePosition: position } : {}),
  };
}

export function parseArtifacts(body: unknown): SumeArtifact[] {
  const data = unwrap(body, "result response");
  const list = record(data.result)?.artifacts;
  if (!Array.isArray(list) || list.length === 0) {
    throw new SumeMalformedResponseError("completed job has no artifacts");
  }
  return list.map((item) => {
    const a = record(item);
    const url = typeof a?.url === "string" ? a.url : "";
    if (!a || !/^https:\/\//i.test(url)) {
      throw new SumeMalformedResponseError("artifact without an https URL");
    }
    const artifact: SumeArtifact = { url };
    const id = text(a.id, 128);
    if (id) artifact.id = id;
    const type = text(a.type, 40);
    if (type) artifact.type = type;
    const contentType = text(a.content_type, 120);
    if (contentType) artifact.contentType = contentType;
    const size = nonNegative(a.size_bytes);
    if (size !== undefined) artifact.sizeBytes = size;
    return artifact;
  });
}

export function parseJob(body: unknown, requested: string): SumeJob {
  const data = unwrap(body, "job response");
  const job = record(data.job) ?? data;
  const id = isValidJobId(job.id) ? job.id : requested;
  const status = normalizeStatus(job.status) ?? statusOf(data);
  if (!status) throw new SumeMalformedResponseError("job response has no status");
  const out: SumeJob = { id, status };
  const model = text(job.model, 128);
  if (model) out.model = model;
  const created = text(job.created_at, 64);
  if (created) out.createdAt = created;
  const summary = record(job.usage_summary) ?? record(data.usage_summary);
  if (summary) {
    const state = text(summary.status, 40)?.toLowerCase();
    const cents = nonNegative(summary.captured_usd_cents);
    out.charge = {
      ...(state ? { status: state } : {}),
      ...(cents !== undefined ? { capturedUsd: cents / 100 } : {}),
    };
  }
  const error = record(job.error);
  if (error) {
    out.error = {
      ...(text(error.code, 80) ? { code: text(error.code, 80) } : {}),
      ...(text(error.message) ? { message: text(error.message) } : {}),
      ...(text(error.public_reason, 80) ? { publicReason: text(error.public_reason, 80) } : {}),
    };
  }
  return out;
}

export interface SumeClientOptions {
  /** Needed for every route except the public catalog. */
  apiKey?: string;
  /** Defaults to https://api.sume.com. */
  baseUrl?: string;
  /** Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Injectable for tests (retry back-off, polling). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Slowest upload speed to allow for, in bytes per second (default 1 MB/s). */
  minUploadBytesPerSec?: number;
}

export interface SumeWaitOptions {
  timeoutMs: number;
  /** Appended to the timeout message, e.g. a resume command. */
  resumeHint?: string;
  onPoll?: (status: SumeJobStatus, attempt: number) => void;
}

export interface SumeUploadOptions {
  data: Blob;
  contentType: string;
  filename?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function newIdempotencyKey(): string {
  return `multix-${globalThis.crypto.randomUUID()}`;
}

export class SumeClient {
  private readonly apiKey: string;
  readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minUploadBytesPerSec: number;

  constructor(opts: SumeClientOptions = {}) {
    this.apiKey = opts.apiKey?.trim() ?? "";
    this.baseUrl = (opts.baseUrl || DEFAULT_SUME_BASE_URL).replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.minUploadBytesPerSec = opts.minUploadBytesPerSec ?? DEFAULT_MIN_UPLOAD_BYTES_PER_SEC;
  }

  get catalogUrl(): string {
    return `${this.baseUrl}${SUME_CATALOG_PATH}`;
  }

  private key(): string {
    if (!this.apiKey) throw new ProviderError(`Sume API key (${KEY_ENV}) is required`, PROVIDER);
    return this.apiKey;
  }

  /** Keyed request: throws HttpError (secret scrubbed) so callers can classify it. */
  private raw<T>(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<T> {
    const key = this.key();
    return fetchJson<T>({
      url: `${this.baseUrl}${path}`,
      method,
      headers: { accept: "application/json", authorization: `Bearer ${key}`, ...opts.headers },
      body,
      timeoutMs: opts.timeoutMs ?? REQUEST_TIMEOUT_MS,
      fetch: this.doFetch,
    }).catch((error: unknown) => {
      throw scrubSecret(error, key);
    });
  }

  /** Public catalog: no key is sent. */
  async catalog(): Promise<SumeCatalog> {
    let body: unknown;
    try {
      body = await fetchJson<unknown>({
        url: this.catalogUrl,
        headers: { accept: "application/json" },
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBytes: CATALOG_MAX_BYTES,
        fetch: this.doFetch,
      });
    } catch (error) {
      throw mapSumeError(error, "the model catalog");
    }
    try {
      return parseCatalog(body);
    } catch (error) {
      throw new SumeMalformedResponseError((error as Error).message);
    }
  }

  /** One public catalog row (ids may contain "/", so the id is URL-encoded). */
  async getModel(id: string): Promise<SumeModel> {
    const safeId = assertModelId(id);
    let body: unknown;
    try {
      body = await fetchJson<unknown>({
        url: `${this.catalogUrl}/${encodeURIComponent(safeId)}`,
        headers: { accept: "application/json" },
        timeoutMs: REQUEST_TIMEOUT_MS,
        fetch: this.doFetch,
      });
    } catch (error) {
      throw mapSumeError(error, `model ${safeId}`);
    }
    const model = parseCatalogModel(record(body)?.data);
    if (!model) throw new SumeMalformedResponseError("catalog row has no id or kind");
    return model;
  }

  /**
   * Submit a generation. The same Idempotency-Key is sent on every attempt, so
   * a retry after a lost answer returns the job already created (charged once).
   * Final refusals (400, 402, 403, 409, 422) are never retried.
   */
  async generate(
    router: "image" | "video",
    body: Record<string, unknown> & { model: string },
    opts: { idempotencyKey?: string } = {},
  ): Promise<SumeSubmitted> {
    const key = opts.idempotencyKey
      ? assertIdempotencyKey(opts.idempotencyKey)
      : newIdempotencyKey();
    const path = router === "image" ? "/v1/image-router/generate" : "/v1/video-router/generate";
    const subject = `model ${body.model}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.raw<unknown>(path, "POST", body, {
          headers: { "idempotency-key": key },
        });
        return parseSubmitted(response, key);
      } catch (error) {
        const retry = isTransientHttpError(error) || error instanceof SumeMalformedResponseError;
        if (retry && attempt < SUBMIT_MAX_RETRIES) {
          const after = error instanceof HttpError ? error.retryAfterMs : undefined;
          await this.sleep(Math.min(after ?? 2_000 * (attempt + 1), SUBMIT_RETRY_CAP_MS));
          continue;
        }
        throw withOrphanHint(mapSumeError(error, subject), key);
      }
    }
  }

  async getStatus(id: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<SumeJobStatus> {
    const safeId = assertJobId(id);
    try {
      const body = await this.raw<unknown>(`/v1/jobs/${safeId}/status`, "GET", undefined, {
        timeoutMs,
      });
      return parseStatus(body, safeId);
    } catch (error) {
      throw mapSumeError(error, `job ${safeId}`);
    }
  }

  /**
   * Poll until the job is terminal and return its last status (callers decide
   * success). Honours Sume's next_poll_after_seconds (never below 2s), retries
   * network/408/429/5xx (honouring Retry-After), throws PollTimeoutError on
   * the deadline.
   */
  async waitForJob(id: string, opts: SumeWaitOptions): Promise<SumeJobStatus> {
    const safeId = assertJobId(id);
    const deadline = this.now() + opts.timeoutMs;
    let backoff = MIN_POLL_INTERVAL_MS;
    let last: SumeJobStatus | undefined;
    let lastError: unknown;
    for (let attempt = 1; ; attempt++) {
      let delay: number;
      try {
        const remaining = Math.max(1, Math.ceil(deadline - this.now()));
        const body = await this.raw<unknown>(`/v1/jobs/${safeId}/status`, "GET", undefined, {
          timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remaining),
        });
        last = parseStatus(body, safeId);
        lastError = undefined;
        opts.onPoll?.(last, attempt);
        if (last.terminal) return last;
        delay =
          last.nextPollAfterSeconds !== undefined ? last.nextPollAfterSeconds * 1000 : backoff;
      } catch (error) {
        if (!isTransientHttpError(error)) throw mapSumeError(error, `job ${safeId}`);
        lastError = error;
        delay = (error as HttpError).retryAfterMs ?? backoff;
      }
      backoff = Math.min(backoff * 1.5, POLL_MAX_INTERVAL_MS);
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        const hint = opts.resumeHint ? ` ${opts.resumeHint}` : "";
        const cause =
          lastError instanceof Error
            ? ` Last error: ${(mapSumeError(lastError, `job ${safeId}`) as Error).message}.`
            : "";
        throw new PollTimeoutError(
          `Timed out after ${opts.timeoutMs}ms waiting for Sume job ${safeId} (last status: ${last?.status ?? "unknown"}).${cause}${hint}`,
          last,
        );
      }
      await this.sleep(
        Math.min(Math.max(delay, MIN_POLL_INTERVAL_MS), POLL_MAX_INTERVAL_MS, remaining),
      );
    }
  }

  /** Output artifacts of a completed job (409 job_not_completed / job_failed / job_canceled otherwise). */
  async getResult(id: string): Promise<SumeArtifact[]> {
    const safeId = assertJobId(id);
    try {
      return parseArtifacts(await this.raw<unknown>(`/v1/jobs/${safeId}/result`, "GET"));
    } catch (error) {
      throw mapSumeError(error, `the result of job ${safeId}`);
    }
  }

  /** The job envelope, including `error` for failed and canceled jobs. */
  async getJob(id: string): Promise<SumeJob> {
    const safeId = assertJobId(id);
    try {
      return parseJob(await this.raw<unknown>(`/v1/jobs/${safeId}`, "GET"), safeId);
    } catch (error) {
      throw mapSumeError(error, `job ${safeId}`);
    }
  }

  /**
   * Cancel a job that has not started generating (refunded). 409
   * job_generation_already_started / job_not_cancelable are mapped errors;
   * canceling an already canceled job succeeds.
   */
  async cancel(id: string): Promise<SumeCancelResult> {
    const safeId = assertJobId(id);
    let body: unknown;
    try {
      body = await this.raw<unknown>(`/v1/jobs/${safeId}/cancel`, "POST");
    } catch (error) {
      throw mapSumeError(error, `cancel of job ${safeId}`);
    }
    const data = unwrap(body, "cancel response");
    const status = statusOf(data) ?? "canceled";
    return {
      jobId: jobIdOf(data) ?? safeId,
      status,
      canceled: data.canceled === true || status === "canceled",
      alreadyCanceled: data.idempotency_hit === true,
    };
  }

  /** Free key check: the workspace balance in USD. */
  async balance(): Promise<SumeBalance> {
    let body: unknown;
    try {
      body = await this.raw<unknown>("/v1/open/balance", "GET");
    } catch (error) {
      throw mapSumeError(error, "the balance");
    }
    const data = unwrap(body, "balance response");
    const out: SumeBalance = {};
    const balance = nonNegative(data.balance);
    if (balance !== undefined) out.balance = balance;
    const currency = text(data.currency, 10);
    if (currency) out.currency = currency;
    const month = nonNegative(data.usage_this_month);
    if (month !== undefined) out.usage_this_month = month;
    const micros = nonNegative(data.balance_usd_micros);
    if (micros !== undefined) out.balance_usd_micros = micros;
    return out;
  }

  /**
   * Sume's own price quote for an input (POST /v1/open/estimate, not billed).
   * Its response shape is undocumented, so `data` is returned as is.
   */
  async estimate(model: string, input: Record<string, unknown>): Promise<unknown> {
    const safeModel = assertModelId(model);
    let body: unknown;
    try {
      body = await this.raw<unknown>("/v1/open/estimate", "POST", { model: safeModel, input });
    } catch (error) {
      throw mapSumeError(error, `a quote for model ${safeModel}`);
    }
    const data = record(body)?.data;
    if (data === undefined) throw new SumeMalformedResponseError("quote response has no data");
    return data;
  }

  /**
   * Upload a local file: ask for a signed PUT URL, then PUT the bytes there
   * with exactly the headers Sume returned and no API key. Returns the public
   * URL to pass as a generation input. The signed URL is never logged.
   */
  async uploadFile(opts: SumeUploadOptions): Promise<string> {
    const label = opts.filename ? `upload ${clean(opts.filename).slice(0, 100)}` : "an upload";
    let body: unknown;
    try {
      body = await this.raw<unknown>("/v1/files/generate-upload-url", "POST", {
        content_type: opts.contentType,
        size_bytes: opts.data.size,
        ...(opts.filename ? { filename: opts.filename } : {}),
      });
    } catch (error) {
      throw mapSumeError(error, label);
    }
    const ticket = parseUploadTicket(body);
    // The storage URL comes from the API; never send user files to a local or private address.
    checkUrlSafety(ticket.upload_url, { provider: PROVIDER, action: "upload to" });
    checkUrlSafety(ticket.public_url, { provider: PROVIDER, action: "use" });
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(ticket.upload_headers)) {
      const lower = name.toLowerCase();
      if (lower === "content-length") {
        // fetch sets it from the body; a different size means the ticket is not for this file.
        if (value.trim() !== String(opts.data.size)) {
          throw new SumeMalformedResponseError("upload ticket is for a different file size");
        }
        continue;
      }
      if (/^(authorization|cookie|x-api-key|host)$/.test(lower)) {
        throw new SumeMalformedResponseError(`upload ticket asks for the ${lower} header`);
      }
      headers[lower] = value;
    }
    const timeoutMs =
      UPLOAD_BASE_TIMEOUT_MS + Math.ceil((opts.data.size / this.minUploadBytesPerSec) * 1000);
    let response: Response;
    try {
      response = await this.doFetch(ticket.upload_url, {
        method: "PUT",
        headers,
        body: opts.data,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw mapSumeError(toFetchError(cause, ticket.upload_url, { provider: PROVIDER }), label);
    }
    if (!response.ok) {
      throw mapSumeError(await httpErrorFromResponse(response, ticket.upload_url), label);
    }
    await response.body?.cancel().catch(() => {});
    return ticket.public_url;
  }
}

function parseUploadTicket(body: unknown): SumeUploadTicket {
  const data = unwrap(body, "upload response");
  const headers = record(data.upload_headers) ?? {};
  if (
    typeof data.upload_url !== "string" ||
    typeof data.public_url !== "string" ||
    (data.upload_method !== undefined && data.upload_method !== "PUT") ||
    !Object.values(headers).every((v) => typeof v === "string")
  ) {
    throw new SumeMalformedResponseError("upload response is missing upload_url or public_url");
  }
  return {
    upload_url: data.upload_url,
    public_url: data.public_url,
    upload_method: "PUT",
    upload_headers: headers as Record<string, string>,
    ...(typeof data.expires_at === "string" ? { expires_at: data.expires_at } : {}),
    ...(typeof data.asset_id === "string" ? { asset_id: data.asset_id } : {}),
  };
}
