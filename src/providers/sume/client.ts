/**
 * Sume REST client (image/video generate routers, jobs, estimate, uploads).
 *
 * Runtime-neutral: no node:* imports and no env/logger/fs access, so the same
 * client runs in the CLI and in a Cloudflare Worker. Callers pass the API key,
 * an optional base URL and an optional fetch implementation.
 *
 * API contract (https://www.sume.com/docs):
 * - Auth: `Authorization: Bearer <SUME_API_KEY>`; bodies are wrapped as `{data}` or `{error}`.
 * - Submit: POST /v1/{image,video}-router/generate -> 202 `{data:{job, status_url, ...}}`,
 *   with an `Idempotency-Key` header so a deliberate resend returns the same job.
 * - Status: GET /v1/jobs/{id}/status; result: GET /v1/jobs/{id}/result;
 *   whole job (with `usage_summary`): GET /v1/jobs/{id}; cancel: POST /v1/jobs/{id}/cancel.
 * - Estimate: POST /v1/open/estimate (non-billable); catalog: GET /v1/open/catalog (public).
 * - Upload: POST /v1/files/generate-upload-url, then PUT the bytes to `upload_url`.
 *
 * A generate POST is sent once and never retried here: a cut-off connection or
 * a gateway 5xx without Sume's error body leaves the job's existence unknown
 * (UNKNOWN_REMOTE_STATE). Status reads retry with backoff and honour Retry-After.
 */

import { isTransientHttpError, pollUntil } from "../../core/async-poll.js";
import {
  ConfigError,
  HttpError,
  MultixError,
  ProviderError,
  ValidationError,
} from "../../core/errors.js";
import { toFetchError } from "../../core/fetch-error.js";
import {
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  fetchJson,
  parseRetryAfter,
} from "../../core/fetch-json.js";
import { fetchFollowingRedirects } from "../../core/redirect-fetch.js";
import {
  NOT_SENT_CODES,
  UNKNOWN_REMOTE_STATE,
  errorCodes,
  readCappedText,
} from "../../core/response-read.js";
import { DEFAULT_SUME_BASE_URL, SUME_KEY_URL, SUME_PATHS, SUME_PROVIDER } from "./models.js";
import type {
  SumeCancelResult,
  SumeClientOptions,
  SumeEstimate,
  SumeJob,
  SumeJobResult,
  SumeJobStatus,
  SumeRouter,
  SumeSubmitResult,
  SumeUploadTarget,
  SumeWaitOptions,
} from "./types.js";

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Documented: 1–255 printable ASCII characters. */
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;
const RESPONSE_MAX_BYTES = 1024 * 1024;
const DEFAULT_UPLOAD_TIMEOUT_MS = 600_000;
const TERMINAL_STATES = new Set(["completed", "failed", "canceled"]);

export function assertValidJobId(id: string): void {
  if (!JOB_ID_RE.test(id)) throw new ValidationError(`Invalid Sume job id: "${id}"`);
}

export function assertValidIdempotencyKey(key: string): void {
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw new ValidationError(
      "--idempotency-key must be 1-255 printable ASCII characters without spaces",
    );
  }
}

/** Lower-case job state from either spelling (`sume_status` or the upper-case `status`). */
export function jobState(s: { sume_status?: string; status?: string }): string {
  const raw = s.sume_status ?? s.status ?? "";
  const lower = raw.toLowerCase();
  if (lower === "in_queue") return "queued";
  if (lower === "in_progress") return "processing";
  if (lower === "cancelled") return "canceled";
  return lower;
}

export function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

/** `{error:{code, message, request_id, retry_after_seconds}}` of a Sume error body, if it is one. */
export function parseSumeError(
  text: string,
): { code: string; message: string; requestId?: string; retryAfterS?: number } | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: Record<string, unknown> } | null;
    const e = parsed?.error;
    if (!e || typeof e !== "object" || typeof e.code !== "string") return undefined;
    return {
      code: e.code,
      message: typeof e.message === "string" ? e.message : "",
      ...(typeof e.request_id === "string" ? { requestId: e.request_id } : {}),
      ...(typeof e.retry_after_seconds === "number" && e.retry_after_seconds >= 0
        ? { retryAfterS: e.retry_after_seconds }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** Codes Sume documents as "not charged" refusals of the balance or a key's spend limit. */
const SPEND_REFUSALS = new Set(["insufficient_funds", "api_key_spend_limit_exceeded"]);

/** HttpError carrying Sume's code and message (no key, no signed URL: the body never holds one). */
export function sumeHttpError(
  status: number,
  text: string,
  url: string,
  retryAfter?: string | null,
) {
  const parsed = parseSumeError(text);
  const retryAfterMs =
    parseRetryAfter(retryAfter) ??
    (parsed?.retryAfterS !== undefined ? parsed.retryAfterS * 1000 : undefined);
  if (!parsed) return new HttpError(status, text.slice(0, 500), url, retryAfterMs);
  const quota = SPEND_REFUSALS.has(parsed.code)
    ? " (balance or spend-limit quota reached; not charged)"
    : "";
  const request = parsed.requestId ? ` [request ${parsed.requestId}]` : "";
  return new HttpError(
    status,
    `${parsed.code}: ${parsed.message}${quota}${request}`.slice(0, 500),
    url,
    retryAfterMs,
  );
}

/** A generate POST whose outcome is unknown: the job may exist and be billed. */
export function sumeUnknownState(
  reason: string,
  idempotencyKey: string,
  cause?: unknown,
): MultixError {
  return new MultixError(
    `Sume generate request was cut off (${reason}) after it may have been accepted, so a job may exist and be billed. Do not resubmit blindly: list recent jobs (GET /v1/jobs) or resend the same command with --idempotency-key ${idempotencyKey}, which returns the original job instead of charging again.`,
    UNKNOWN_REMOTE_STATE,
    cause === undefined ? undefined : { cause },
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The `data` member of a Sume response, or a ProviderError naming the call. */
export function envelopeData(body: unknown, what: string): Record<string, unknown> {
  const data = record(record(body)?.data);
  if (!data) throw new ProviderError(`Sume ${what}: response has no data`, SUME_PROVIDER);
  return data;
}

function jobFrom(value: unknown): SumeJob | undefined {
  const job = record(value);
  return job && typeof job.id === "string" && job.id ? (job as unknown as SumeJob) : undefined;
}

export class SumeClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;

  constructor(opts: SumeClientOptions) {
    if (!opts.apiKey?.trim()) {
      throw new ConfigError(`SUME_API_KEY is not set. Create one as described at ${SUME_KEY_URL}`);
    }
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl?.trim() || DEFAULT_SUME_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.uploadTimeoutMs = opts.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  }

  private doFetch(input: string, init?: RequestInit): Promise<Response> {
    // Call without a receiver: Workers' native fetch throws "Illegal invocation"
    // when invoked as a method of another object.
    const f = this.fetchImpl;
    return f ? f(input, init) : globalThis.fetch(input, init);
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
  }

  private async getData(path: string, what: string, timeoutMs?: number) {
    const body = await fetchJson<unknown>({
      url: `${this.baseUrl}${path}`,
      headers: this.authHeaders(),
      timeoutMs: timeoutMs ?? this.timeoutMs,
      maxBytes: RESPONSE_MAX_BYTES,
      fetch: (input, init) => this.doFetch(input, init),
    });
    return envelopeData(body, what);
  }

  /**
   * POST once, never retried. Sume's own error answer becomes an HttpError
   * (nothing was created); a broken connection or a 5xx without Sume's error
   * body becomes UNKNOWN_REMOTE_STATE when `creates` is set.
   */
  private async postOnce(
    path: string,
    body: unknown,
    opts: { headers?: Record<string, string>; creates?: string },
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      ({ response } = await fetchFollowingRedirects(
        url,
        {
          method: "POST",
          headers: { ...this.authHeaders(), "Content-Type": "application/json", ...opts.headers },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
        { fetch: (input, init) => this.doFetch(input, init), crossOrigin: "error" },
      ));
    } catch (cause) {
      if (cause instanceof MultixError) throw cause;
      const notSent = errorCodes(cause).some((c) => NOT_SENT_CODES.has(c));
      const mapped = toFetchError(cause, url, { provider: SUME_PROVIDER });
      if (opts.creates && mapped instanceof HttpError && !notSent) {
        throw sumeUnknownState(mapped.snippet || "connection lost", opts.creates, cause);
      }
      throw mapped;
    }
    const text = await readCappedText(response, RESPONSE_MAX_BYTES);
    if (!response.ok) {
      if (opts.creates && response.status >= 500 && !parseSumeError(text)) {
        throw sumeUnknownState(`HTTP ${response.status} from the gateway`, opts.creates);
      }
      throw sumeHttpError(response.status, text, url, response.headers.get("retry-after"));
    }
    try {
      return envelopeData(JSON.parse(text), path);
    } catch (error) {
      if (opts.creates) throw sumeUnknownState("unreadable response body", opts.creates, error);
      throw error instanceof MultixError
        ? error
        : new ProviderError(`Sume ${path}: response is not JSON`, SUME_PROVIDER);
    }
  }

  /** Submit a generation job once. `body` holds `model` plus the model's own fields. */
  async submit(
    router: SumeRouter,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<SumeSubmitResult> {
    if (typeof body.model !== "string" || !body.model.trim()) {
      throw new ValidationError("Sume request body needs a non-empty `model`");
    }
    assertValidIdempotencyKey(idempotencyKey);
    const path = router === "image" ? SUME_PATHS.imageGenerate : SUME_PATHS.videoGenerate;
    const data = await this.postOnce(path, body, {
      headers: { "Idempotency-Key": idempotencyKey },
      creates: idempotencyKey,
    });
    const job = jobFrom(data.job);
    if (!job) {
      // Accepted (2xx) but no id: the job may exist; the key finds it again.
      throw sumeUnknownState("the response named no job id", idempotencyKey);
    }
    return { ...(data as Omit<SumeSubmitResult, "job">), job };
  }

  /** One status read. */
  async getStatus(id: string, timeoutMs?: number): Promise<SumeJobStatus> {
    assertValidJobId(id);
    const data = await this.getData(`${SUME_PATHS.jobs}/${id}/status`, "job status", timeoutMs);
    return { ...(data as Omit<SumeJobStatus, "job_id">), job_id: id };
  }

  /** The whole job, including its `usage_summary` (the settled charge once final). */
  async getJob(id: string): Promise<SumeJob> {
    assertValidJobId(id);
    const data = await this.getData(`${SUME_PATHS.jobs}/${id}`, "job");
    const job = jobFrom(data.job) ?? jobFrom(data);
    if (!job) throw new ProviderError(`Sume job ${id}: response has no job`, SUME_PROVIDER);
    return job;
  }

  /** Artifacts of a completed job (409 job_not_completed / job_failed / job_canceled otherwise). */
  async getResult(id: string): Promise<SumeJobResult> {
    assertValidJobId(id);
    const data = await this.getData(`${SUME_PATHS.jobs}/${id}/result`, "job result");
    const result = record(data.result);
    const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];
    return {
      job_id: typeof data.job_id === "string" ? data.job_id : id,
      ...(typeof data.status === "string" ? { status: data.status } : {}),
      artifacts: artifacts.filter(
        (a): a is SumeJobResult["artifacts"][number] =>
          !!record(a) && typeof (a as { url?: unknown }).url === "string",
      ),
      ...(jobFrom(data.job) ? { job: jobFrom(data.job) } : {}),
    };
  }

  /** Cancel before generation starts. Sent once; a 409 says it can no longer be canceled. */
  async cancel(id: string): Promise<SumeCancelResult> {
    assertValidJobId(id);
    const data = await this.postOnce(`${SUME_PATHS.jobs}/${id}/cancel`, {}, {});
    return {
      ...(data as Omit<SumeCancelResult, "job">),
      ...(jobFrom(data.job) ? { job: jobFrom(data.job) } : {}),
    };
  }

  /** Non-billable price of one request (`input` is the generate body without `model`). */
  async estimate(model: string, input: Record<string, unknown>): Promise<SumeEstimate> {
    const data = await this.postOnce(SUME_PATHS.estimate, { model, input }, {});
    if (
      typeof data.usd_micros !== "number" ||
      !Number.isFinite(data.usd_micros) ||
      data.usd_micros < 0
    ) {
      throw new ProviderError("Sume estimate returned no usd_micros", SUME_PROVIDER);
    }
    return data as unknown as SumeEstimate;
  }

  /** Reserve an upload URL for `sizeBytes` of `contentType`. */
  async createUpload(opts: {
    contentType: string;
    sizeBytes: number;
    filename?: string;
  }): Promise<SumeUploadTarget> {
    const data = await this.postOnce(
      SUME_PATHS.uploadUrl,
      {
        content_type: opts.contentType,
        size_bytes: opts.sizeBytes,
        ...(opts.filename ? { filename: opts.filename } : {}),
      },
      {},
    );
    const publicUrl = data.public_url;
    const uploadUrl = data.upload_url;
    if (
      typeof publicUrl !== "string" ||
      !/^https:\/\//i.test(publicUrl) ||
      typeof uploadUrl !== "string" ||
      !/^https:\/\//i.test(uploadUrl)
    ) {
      throw new ProviderError("Sume upload URL response is missing https URLs", SUME_PROVIDER);
    }
    return data as unknown as SumeUploadTarget;
  }

  /**
   * PUT the bytes to the pre-signed URL with exactly the headers Sume returned.
   * The API key is never sent there, and errors never print the signed URL's query.
   */
  async putUpload(target: SumeUploadTarget, body: Blob | Uint8Array): Promise<void> {
    if ((target.upload_method ?? "PUT").toUpperCase() !== "PUT") {
      throw new ProviderError(
        `Sume upload method ${target.upload_method} is not supported`,
        SUME_PROVIDER,
      );
    }
    // fetch sets content-length from the body itself (the signed size is the file's size).
    const headers = Object.fromEntries(
      Object.entries(target.upload_headers ?? {}).filter(
        ([name, value]) =>
          typeof value === "string" &&
          !/^(authorization|x-api-key|host|content-length)$/i.test(name),
      ),
    );
    let response: Response;
    try {
      response = await this.doFetch(target.upload_url, {
        method: "PUT",
        headers,
        body: body as RequestInit["body"],
        signal: AbortSignal.timeout(this.uploadTimeoutMs),
      });
    } catch (cause) {
      throw toFetchError(cause, target.upload_url, {
        provider: SUME_PROVIDER,
        prefix: "Upload failed: ",
      });
    }
    if (!response.ok) {
      const text = await readCappedText(response, 2048);
      throw new HttpError(response.status, text.slice(0, 300), target.upload_url);
    }
  }

  /**
   * Poll the status until terminal or the deadline. Network errors, 408, 429
   * (honouring Retry-After) and 5xx are retried. Throws PollTimeoutError.
   */
  waitForJob(id: string, opts: SumeWaitOptions): Promise<SumeJobStatus> {
    assertValidJobId(id);
    return pollUntil<SumeJobStatus>({
      fetchStatus: ({ remainingMs }) =>
        this.getStatus(id, Math.ceil(Math.max(1000, Math.min(this.timeoutMs, remainingMs)))),
      isTerminal: (s) => s.terminal === true || isTerminalState(jobState(s)),
      timeoutMs: opts.timeoutMs,
      // Sume asks for 2 s between reads while a job runs.
      intervalMs: opts.intervalMs ?? 2000,
      maxIntervalMs: opts.maxIntervalMs ?? 15_000,
      isTransientError: isTransientHttpError,
      onPoll: opts.onPoll,
      resumeHint: opts.resumeHint,
      sleep: opts.sleep,
      now: opts.now,
    });
  }
}
