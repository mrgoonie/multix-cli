/**
 * Direct Sume API client (https://api.sume.com).
 *
 * Runtime-neutral: no node:* imports, no env/logger/disk access. Callers pass
 * `apiKey`, optional `baseUrl`, `fetch` and `sleep`, so the same client runs
 * in the Node CLI and in non-Node runtimes such as a Cloudflare Worker.
 *
 * - Submit: POST /v1/image-router/generate | /v1/video-router/generate → data.job
 * - Jobs: GET /v1/jobs/{id}/status, GET /v1/jobs/{id}/result, GET /v1/jobs/{id},
 *   POST /v1/jobs/{id}/cancel
 * - Uploads: POST /v1/files/generate-upload-url, then PUT the bytes (no key)
 *
 * Every submit carries an Idempotency-Key, so a retry after a network error,
 * a timeout, a rate limit, a full queue or a retryable server error resends
 * the same request with the same key and Sume charges it at most once.
 */

import { PollTimeoutError, isTransientHttpError } from "../../core/async-poll.js";
import { HttpError, ProviderError } from "../../core/errors.js";
import { toFetchError } from "../../core/fetch-error.js";
import { type FetchLike, fetchJson, httpErrorFromResponse } from "../../core/fetch-json.js";
import { checkUrlSafety } from "../../core/url-safety.js";
import {
  SumeSubmitError,
  mapSumeError,
  parseErrorEnvelope,
  retryAfterMsOf,
  scrubSecret,
} from "./errors.js";
import { estimateSume } from "./estimate.js";
import {
  DEFAULT_SUME_BASE_URL,
  assertIdempotencyKey,
  assertJobId,
  isTerminalStatus,
  isValidJobId,
} from "./models.js";
import type {
  SumeArtifact,
  SumeCancelResult,
  SumeEstimate,
  SumeJob,
  SumeJobError,
  SumeJobStatus,
  SumeRequestBody,
  SumeResult,
  SumeSubmitted,
  SumeUploadTicket,
  SumeUsageSummary,
} from "./types.js";

const PROVIDER = "sume";
const REQUEST_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 30_000;
/** Retries of one submit (same body, same key) after the first attempt. */
export const SUBMIT_MAX_RETRIES = 3;
const SUBMIT_RETRY_CAP_MS = 60_000;
const READ_MAX_RETRIES = 2;
/** Sume asks for 2 s between status reads while a job runs. */
const MIN_POLL_INTERVAL_MS = 2_000;
const MAX_POLL_INTERVAL_MS = 30_000;
/** Slowest uplink an upload allows for before timing out (1 MB/s). */
const MIN_UPLOAD_BYTES_PER_SEC = 1_000_000;

/** Server errors that refuse the job outright: nothing was created, so a retry is not ambiguous. */
const REFUSED_SERVER_CODES = new Set([
  "provider_not_configured",
  "provider_capacity_exceeded",
  "provider_submission_failed",
]);

const STATUS_ALIASES: Record<string, SumeJobStatus> = {
  queued: "queued",
  in_queue: "queued",
  processing: "processing",
  in_progress: "processing",
  completed: "completed",
  failed: "failed",
  canceled: "canceled",
  cancelled: "canceled",
};

function record(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function malformed(what: string): ProviderError {
  return new ProviderError(`Malformed Sume response: ${what}`, PROVIDER);
}

/** The `data` member every successful Sume response wraps its payload in. */
function unwrap(body: unknown): Record<string, unknown> {
  const data = record(record(body)?.data);
  if (!data) throw malformed("missing data");
  return data;
}

function normalizeStatus(value: unknown): SumeJobStatus | undefined {
  return typeof value === "string" ? STATUS_ALIASES[value.toLowerCase()] : undefined;
}

function parseJobError(v: unknown): SumeJobError | undefined {
  const e = record(v);
  if (!e) return undefined;
  const out: SumeJobError = {};
  if (str(e.code)) out.code = str(e.code);
  if (str(e.message)) out.message = str(e.message);
  if (str(e.public_reason)) out.public_reason = str(e.public_reason);
  if (typeof e.retryable === "boolean") out.retryable = e.retryable;
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseUsageSummary(v: unknown): SumeUsageSummary | undefined {
  const u = record(v);
  if (!u) return undefined;
  const out: SumeUsageSummary = {};
  if (str(u.status)) out.status = str(u.status);
  for (const key of [
    "reserved_usd_cents",
    "captured_usd_cents",
    "refunded_usd_cents",
    "released_usd_cents",
  ] as const) {
    const value = num(u[key]);
    if (value !== undefined) out[key] = value;
  }
  if (typeof u.final === "boolean") out.final = u.final;
  return out;
}

/**
 * Normalize a job from a submit envelope (`data.job` plus envelope fields),
 * a status response (`data` with `job_id`, `sume_status`, optional `job`) or a
 * full-job response. Throws when the id or status is missing or unknown.
 */
export function parseJob(raw: unknown, envelope?: Record<string, unknown>): SumeJob {
  const top = record(raw);
  if (!top) throw malformed("missing job");
  const nested = record(top.job);
  const id = str(top.job_id) ?? str(top.id) ?? str(nested?.id) ?? str(top.request_id);
  if (!isValidJobId(id)) throw malformed("missing or invalid job id");
  const status =
    normalizeStatus(top.sume_status) ??
    normalizeStatus(top.status) ??
    normalizeStatus(nested?.status);
  if (!status) throw malformed(`unknown job status for ${id}`);
  const job: SumeJob = { id, status, terminal: isTerminalStatus(status) };
  const ctx = envelope ?? top;
  const model = str(top.model) ?? str(nested?.model);
  if (model) job.model = model;
  const createdAt = str(top.created_at) ?? str(nested?.created_at);
  if (createdAt) job.createdAt = createdAt;
  if (typeof ctx.cancelable === "boolean") job.cancelable = ctx.cancelable;
  const poll = num(ctx.next_poll_after_seconds);
  if (poll !== undefined && poll >= 0) job.nextPollAfterSeconds = poll;
  const position = num(ctx.queue_position);
  if (position !== undefined) job.queuePosition = position;
  const error = parseJobError(top.error) ?? parseJobError(nested?.error);
  if (error) job.error = error;
  const usage = parseUsageSummary(top.usage_summary) ?? parseUsageSummary(nested?.usage_summary);
  if (usage) job.usageSummary = usage;
  return job;
}

function parseArtifact(v: unknown): SumeArtifact | undefined {
  const a = record(v);
  const url = str(a?.url);
  if (!a || !url) return undefined;
  const out: SumeArtifact = { url };
  if (str(a.id)) out.id = str(a.id);
  if (str(a.type)) out.type = str(a.type);
  if (str(a.content_type)) out.content_type = str(a.content_type);
  const size = num(a.size_bytes);
  if (size !== undefined) out.size_bytes = size;
  return out;
}

export interface SumeClientOptions {
  apiKey: string;
  /** Defaults to https://api.sume.com. */
  baseUrl?: string;
  /** Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Injectable for tests (retry and poll delays). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests (poll deadline). */
  now?: () => number;
}

export interface SubmitOptions {
  /** One key per command invocation; every retry of this submit reuses it. */
  idempotencyKey: string;
  /**
   * Builds the command that resubmits safely with the same key, printed when
   * the retries run out and Sume may have accepted the job anyway.
   */
  retryCommand?: (idempotencyKey: string) => string;
  /** Called before each retry (attempt counts from 1). */
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

export interface SumeWaitOptions {
  timeoutMs: number;
  /** Appended to the timeout message, e.g. a resume command. */
  resumeHint?: string;
  onPoll?: (job: SumeJob, attempt: number) => void;
}

export interface SumeUploadOptions {
  data: Blob;
  filename: string;
  contentType: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True when a failed submit may still have created a job on Sume's side. */
export function isAmbiguousSubmitFailure(error: unknown): boolean {
  if (!(error instanceof HttpError))
    return error instanceof ProviderError && /^Malformed/.test(error.message);
  if (error.status === 0) return true;
  if (error.status < 500) return false;
  const code = parseErrorEnvelope(error.snippet)?.code;
  return !(code && REFUSED_SERVER_CODES.has(code));
}

/**
 * Whether a failed submit is worth resending with the same key: network
 * errors and timeouts, 429 (rate_limited, queue_full), and 5xx that Sume
 * marks retryable (or a gateway 502/503/504 without a Sume body). Never 4xx.
 */
export function isRetryableSubmitFailure(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  const { status } = error;
  if (status === 0 || status === 429) return true;
  if (status < 500) return false;
  const env = parseErrorEnvelope(error.snippet);
  if (env?.retryable !== undefined) return env.retryable;
  return env === undefined && (status === 502 || status === 503 || status === 504);
}

export class SumeClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(opts: SumeClientOptions) {
    if (!opts.apiKey) throw new ProviderError("Sume API key is required", PROVIDER);
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_SUME_BASE_URL).replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
  }

  /** Raw keyed request: throws HttpError (key scrubbed) so callers can classify failures. */
  private raw<T>(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
  ): Promise<T> {
    return fetchJson<T>({
      url: `${this.baseUrl}${path}`,
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...opts.headers,
      },
      body,
      timeoutMs: opts.timeoutMs ?? REQUEST_TIMEOUT_MS,
      fetch: this.doFetch,
    }).catch((error: unknown) => {
      throw scrubSecret(error, this.apiKey);
    });
  }

  /** An idempotent read, retried a couple of times on network, 408, 429 and 5xx errors. */
  private async read(path: string, subject: string, timeoutMs?: number): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.raw<unknown>(path, "GET", undefined, { timeoutMs });
      } catch (error) {
        if (attempt < READ_MAX_RETRIES && isTransientHttpError(error)) {
          const wait = error instanceof HttpError ? retryAfterMsOf(error) : undefined;
          await this.sleep(Math.min(wait ?? 1000 * (attempt + 1), SUBMIT_RETRY_CAP_MS));
          continue;
        }
        throw mapSumeError(error, subject);
      }
    }
  }

  /** Public, keyless quote for one request (see estimate.ts). */
  estimate(model: string, input: Record<string, unknown>): Promise<SumeEstimate> {
    return estimateSume(this.doFetch, model, input);
  }

  generateImage(body: SumeRequestBody, opts: SubmitOptions): Promise<SumeSubmitted> {
    return this.submit("/v1/image-router/generate", body, opts);
  }

  generateVideo(body: SumeRequestBody, opts: SubmitOptions): Promise<SumeSubmitted> {
    return this.submit("/v1/video-router/generate", body, opts);
  }

  /**
   * POST a generate request with its Idempotency-Key, resending the same body
   * with the same key on retryable failures. When the retries run out on a
   * failure where Sume may have accepted the job, the error names the key and
   * the command that resubmits safely.
   */
  private async submit(
    path: string,
    body: SumeRequestBody,
    opts: SubmitOptions,
  ): Promise<SumeSubmitted> {
    const key = assertIdempotencyKey(opts.idempotencyKey);
    const subject = `model ${body.model}`;
    const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
    const timeoutMs = REQUEST_TIMEOUT_MS + Math.ceil((bytes / MIN_UPLOAD_BYTES_PER_SEC) * 1000);
    let ambiguous = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.raw<unknown>(path, "POST", body, {
          timeoutMs,
          headers: { "idempotency-key": key },
        });
        return this.parseSubmitted(response, key);
      } catch (error) {
        // A later 4xx answer (other than a rate limit, which may come before
        // the idempotency check) proves no job exists for this key.
        const rateLimited = error instanceof HttpError && error.status === 429;
        ambiguous = isAmbiguousSubmitFailure(error) || (ambiguous && rateLimited);
        if (attempt < SUBMIT_MAX_RETRIES && isRetryableSubmitFailure(error)) {
          const http = error as HttpError;
          const delay = Math.min(retryAfterMsOf(http) ?? 2000 * (attempt + 1), SUBMIT_RETRY_CAP_MS);
          const code = parseErrorEnvelope(http.snippet)?.code;
          opts.onRetry?.(
            attempt + 1,
            delay,
            code ?? (http.status === 0 ? "network error" : `HTTP ${http.status}`),
          );
          await this.sleep(delay);
          continue;
        }
        throw this.submitError(mapSumeError(error, subject), key, ambiguous, opts);
      }
    }
  }

  private parseSubmitted(response: unknown, key: string): SumeSubmitted {
    const data = unwrap(response);
    const job = parseJob(record(data.job) ?? data, data);
    const usage = record(data.usage);
    const submitted: SumeSubmitted = {
      job,
      idempotencyHit: data.idempotency_hit === true,
      idempotencyKey: key,
    };
    const usd = str(usage?.usd);
    if (usd) submitted.usageUsd = usd;
    return submitted;
  }

  private submitError(
    mapped: unknown,
    key: string,
    ambiguous: boolean,
    opts: SubmitOptions,
  ): unknown {
    // A definite refusal (4xx, a full queue, a refused provider) created nothing: keep its error.
    if (!ambiguous || !(mapped instanceof Error)) return mapped;
    const retry =
      opts.retryCommand?.(key) ?? `resend the same request with the header Idempotency-Key: ${key}`;
    return new SumeSubmitError(
      `${mapped.message}. Sume may have accepted the job anyway. Do not resubmit without the same idempotency key (${key}), or it may be charged twice. Retry safely with:\n  ${retry}`,
      key,
      true,
      { cause: mapped },
    );
  }

  /** One status read. */
  async getStatus(id: string): Promise<SumeJob> {
    const safeId = assertJobId(id);
    const data = unwrap(
      await this.read(`/v1/jobs/${safeId}/status`, `job ${safeId}`, STATUS_TIMEOUT_MS),
    );
    return this.checkId(parseJob(data), safeId);
  }

  /** The full job (`GET /v1/jobs/{id}`), which carries `error` and `usage_summary`. */
  async getJob(id: string): Promise<SumeJob> {
    const safeId = assertJobId(id);
    const data = unwrap(await this.read(`/v1/jobs/${safeId}`, `job ${safeId}`));
    return this.checkId(parseJob(record(data.job) ?? data, data), safeId);
  }

  /** Artifacts of a completed job. Sume answers 409 while it runs, or when it failed or was canceled. */
  async getResult(id: string): Promise<SumeResult> {
    const safeId = assertJobId(id);
    const data = unwrap(await this.read(`/v1/jobs/${safeId}/result`, `job ${safeId}`));
    const result = record(data.result);
    if (!result || !Array.isArray(result.artifacts)) throw malformed("result without artifacts");
    const artifacts = result.artifacts.map(parseArtifact).filter((a): a is SumeArtifact => !!a);
    return { jobId: safeId, artifacts };
  }

  /** Cancel a job that has not started generating (409 job_generation_already_started otherwise). */
  async cancel(id: string): Promise<SumeCancelResult> {
    const safeId = assertJobId(id);
    let data: Record<string, unknown>;
    try {
      data = unwrap(await this.raw<unknown>(`/v1/jobs/${safeId}/cancel`, "POST", {}));
    } catch (error) {
      throw mapSumeError(error, `job ${safeId}`);
    }
    const out: SumeCancelResult = {
      jobId: safeId,
      canceled: data.canceled === true,
      idempotencyHit: data.idempotency_hit === true,
    };
    const status = normalizeStatus(data.status) ?? normalizeStatus(data.sume_status);
    if (status) out.status = status;
    const message = str(record(data.cancellation)?.message);
    if (message) out.message = message;
    return out;
  }

  private checkId(job: SumeJob, expected: string): SumeJob {
    if (job.id.toLowerCase() !== expected)
      throw malformed(`job id ${job.id} does not match ${expected}`);
    return job;
  }

  /**
   * Poll status until the job is completed, failed or canceled, and return it:
   * the caller decides success. Waits `next_poll_after_seconds` (at least 2 s)
   * between reads, retries network/408/429/5xx errors (honouring
   * Retry-After), and throws PollTimeoutError with `resumeHint` at the deadline.
   */
  async waitForJob(id: string, opts: SumeWaitOptions): Promise<SumeJob> {
    const safeId = assertJobId(id);
    const deadline = this.now() + opts.timeoutMs;
    let last: SumeJob | undefined;
    let lastError: unknown;
    let failures = 0;
    for (let attempt = 1; ; attempt++) {
      let delay: number;
      try {
        const remaining = Math.max(1, Math.ceil(deadline - this.now()));
        const body = await this.raw<unknown>(`/v1/jobs/${safeId}/status`, "GET", undefined, {
          timeoutMs: Math.min(STATUS_TIMEOUT_MS, remaining),
        });
        last = this.checkId(parseJob(unwrap(body)), safeId);
        lastError = undefined;
        failures = 0;
        opts.onPoll?.(last, attempt);
        if (last.terminal) return last;
        delay = (last.nextPollAfterSeconds ?? 0) * 1000;
      } catch (error) {
        if (!isTransientHttpError(error)) throw mapSumeError(error, `job ${safeId}`);
        lastError = error;
        failures++;
        delay =
          retryAfterMsOf(error as HttpError) ?? MIN_POLL_INTERVAL_MS * 2 ** Math.min(failures, 4);
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        const hint = opts.resumeHint ? ` ${opts.resumeHint}` : "";
        const cause =
          lastError instanceof Error
            ? ` Last error: ${(mapSumeError(lastError, `job ${safeId}`) as Error).message}.`
            : "";
        const state = last ? ` (last status: ${last.status})` : "";
        throw new PollTimeoutError(
          `Timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for Sume job ${safeId}${state}.${cause}${hint}`,
          last,
        );
      }
      const bounded = Math.min(Math.max(delay, MIN_POLL_INTERVAL_MS), MAX_POLL_INTERVAL_MS);
      await this.sleep(Math.min(bounded, remaining));
    }
  }

  /** `POST /v1/files/generate-upload-url`: a one-time PUT URL plus the public URL to pass on. */
  async createUploadUrl(file: {
    content_type: string;
    size_bytes: number;
    filename?: string;
  }): Promise<SumeUploadTicket> {
    const subject = `upload ${file.filename ?? "file"}`;
    let data: Record<string, unknown>;
    try {
      data = unwrap(await this.raw<unknown>("/v1/files/generate-upload-url", "POST", file));
    } catch (error) {
      throw mapSumeError(error, subject);
    }
    const headers = record(data.upload_headers) ?? {};
    const method = str(data.upload_method) ?? "PUT";
    if (
      typeof data.public_url !== "string" ||
      !data.public_url.startsWith("https://") ||
      typeof data.upload_url !== "string" ||
      method.toUpperCase() !== "PUT" ||
      !Object.values(headers).every((v) => typeof v === "string")
    ) {
      throw malformed("upload ticket without public_url, upload_url or PUT method");
    }
    const ticket: SumeUploadTicket = {
      public_url: data.public_url,
      upload_url: data.upload_url,
      upload_method: "PUT",
      upload_headers: headers as Record<string, string>,
    };
    if (str(data.asset_id)) ticket.asset_id = str(data.asset_id);
    if (str(data.expires_at)) ticket.expires_at = str(data.expires_at);
    return ticket;
  }

  /**
   * PUT the bytes to the ticket's storage URL with exactly its headers and no
   * API key. The URL is signed: it is checked (https, public host) and never
   * included in an error message.
   */
  async putUpload(ticket: SumeUploadTicket, data: Blob, filename: string): Promise<void> {
    const subject = `upload ${filename}`;
    const { host } = checkUrlSafety(ticket.upload_url, { provider: PROVIDER, action: "upload to" });
    const headers = Object.fromEntries(
      Object.entries(ticket.upload_headers).filter(
        ([name]) => !["content-length", "host"].includes(name.toLowerCase()),
      ),
    );
    const timeoutMs = REQUEST_TIMEOUT_MS + Math.ceil((data.size / MIN_UPLOAD_BYTES_PER_SEC) * 1000);
    let response: Response;
    try {
      response = await this.doFetch(ticket.upload_url, {
        method: "PUT",
        headers,
        body: data,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw mapSumeError(
        toFetchError(cause, ticket.upload_url, { provider: PROVIDER, target: host }),
        subject,
      );
    }
    if (!response.ok) {
      const error = await httpErrorFromResponse(response, `https://${host}/`);
      throw mapSumeError(error, subject);
    }
    await response.body?.cancel().catch(() => {});
  }

  /** Upload one file and return its public URL, usable in any `*_url` field. */
  async upload(opts: SumeUploadOptions): Promise<string> {
    const ticket = await this.createUploadUrl({
      content_type: opts.contentType,
      size_bytes: opts.data.size,
      filename: opts.filename,
    });
    await this.putUpload(ticket, opts.data, opts.filename);
    return ticket.public_url;
  }
}
