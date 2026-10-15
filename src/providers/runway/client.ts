/**
 * Direct Runway API client (https://api.dev.runwayml.com).
 *
 * Runtime-neutral: no node:* imports, no env/logger/disk access. Callers pass
 * `apiKey`, optional `baseUrl`, and optional `fetch`, so the same client runs
 * in the Node CLI and in non-Node runtimes such as a Cloudflare Worker.
 *
 * - Create: POST /v1/image_to_video | /v1/text_to_video | /v1/text_to_image → { id }
 * - Status: GET /v1/tasks/{id}; cancel (or delete, once finished): DELETE /v1/tasks/{id}
 * - Inputs: POST /v1/uploads returns a presigned form upload and a runway:// URI
 *
 * Create requests have no idempotency key, so only a 429 (nothing created) is
 * retried; any other ambiguous failure carries a dashboard hint instead.
 */

import { PollTimeoutError, isTransientHttpError, pollUntil } from "../../core/async-poll.js";
import { HttpError, ProviderError } from "../../core/errors.js";
import { toFetchError } from "../../core/fetch-error.js";
import { type FetchLike, fetchJson, httpErrorFromResponse } from "../../core/fetch-json.js";
import { checkUrlSafety } from "../../core/url-safety.js";
import {
  DEFAULT_RUNWAY_BASE_URL,
  RUNWAY_API_VERSION,
  RUNWAY_DASHBOARD_LINK,
  assertTaskId,
  isTerminalStatus,
  isValidTaskId,
} from "./models.js";
import type {
  ImageToVideoRequest,
  RunwayCreatedTask,
  RunwayTask,
  RunwayUploadTicket,
  TextToImageRequest,
  TextToVideoRequest,
} from "./types.js";

const PROVIDER = "runway";
const DETAIL_MAX = 300;
const CREATE_MAX_RETRIES = 2;
const CREATE_RETRY_CAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 300_000;
/** Slowest uplink a create request allows for before timing out (1 MB/s). */
const DEFAULT_MIN_UPLOAD_BYTES_PER_SEC = 1_000_000;
/** Runway asks clients not to poll a task more often than every five seconds. */
const MIN_POLL_INTERVAL_MS = 5_000;

const STATUSES = new Set(["PENDING", "THROTTLED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]);

/** Runway API error with an actionable message; keeps status for programmatic use. */
export class RunwayApiError extends ProviderError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, PROVIDER, options);
    this.name = "RunwayApiError";
  }
}

/** A task reached FAILED or CANCELLED — never a success. */
export class RunwayTaskError extends ProviderError {
  constructor(public readonly task: RunwayTask) {
    const code = task.failureCode ? ` [${task.failureCode}]` : "";
    const detail = task.failure ? `: ${task.failure.slice(0, DETAIL_MAX)}` : "";
    super(`Runway task ${task.id} ${task.status.toLowerCase()}${code}${detail}`, PROVIDER);
    this.name = "RunwayTaskError";
  }
}

/** Pull `error` (plus the first validation issue) from a JSON error body, else the raw snippet. */
function errorDetail(snippet: string): string {
  try {
    const body = JSON.parse(snippet) as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof body.error === "string" && body.error) parts.push(body.error);
    const issue = Array.isArray(body.issues) ? (body.issues[0] as Record<string, unknown>) : null;
    if (issue && typeof issue.message === "string") {
      const where = Array.isArray(issue.path) ? issue.path.join(".") : "";
      parts.push(where ? `${where}: ${issue.message}` : issue.message);
    }
    if (parts.length > 0) return parts.join(" — ").slice(0, DETAIL_MAX);
  } catch {
    // not JSON — fall through to the raw snippet
  }
  return snippet.trim().slice(0, DETAIL_MAX);
}

/**
 * Map an HTTP failure to an actionable message. `subject` names what was
 * requested (a model or a task) so 404s point at the right fix.
 */
export function mapRunwayError(error: unknown, subject: string): unknown {
  if (!(error instanceof HttpError)) return error;
  const detail = errorDetail(error.snippet);
  const suffix = detail ? `: ${detail}` : "";
  const { status, retryAfterMs } = error;
  let message: string;
  if (status === 0) {
    message = `Network error contacting Runway${suffix}`;
  } else if (status === 401) {
    message = `Runway rejected the API secret (401). Check RUNWAYML_API_SECRET; create one at ${RUNWAY_DASHBOARD_LINK}`;
  } else if (status === 402) {
    message = `Runway needs more credits for ${subject} (402)${suffix}. Add credits at ${RUNWAY_DASHBOARD_LINK}`;
  } else if (status === 403) {
    message = `Runway denied access to ${subject} (403)${suffix}`;
  } else if (status === 404) {
    message = subject.startsWith("task")
      ? `Runway could not find ${subject} (404); it may belong to another organization, or have been canceled or deleted`
      : `Runway could not find ${subject} (404)${suffix}`;
  } else if (status === 400 || status === 422) {
    message = `Runway rejected the request for ${subject} (${status})${suffix}`;
  } else if (status === 429) {
    const wait =
      retryAfterMs !== undefined ? `; retry after ${Math.ceil(retryAfterMs / 1000)}s` : "";
    message = `Runway rate limit reached (429)${wait}`;
  } else if (status >= 500) {
    message = `Runway server error (${status})${suffix}. Try again later`;
  } else {
    message = `Runway request for ${subject} failed (${status})${suffix}`;
  }
  return new RunwayApiError(message, status, retryAfterMs, { cause: error });
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

export const ORPHAN_HINT = `The task may have been created (and billed) anyway; check your tasks and usage at ${RUNWAY_DASHBOARD_LINK} before retrying to avoid paying twice`;

/**
 * A network error, timeout, 5xx, or an unusable 2xx body on create can happen
 * after Runway has already created the task, leaving no id to resume or
 * cancel. Point the user at the dashboard before they retry.
 */
function withOrphanHint(error: unknown): unknown {
  if (error instanceof RunwayApiError) {
    const { status } = error;
    const mayExist = status === 0 || (status >= 200 && status < 300) || status >= 500;
    if (!mayExist) return error;
    return new RunwayApiError(`${error.message}. ${ORPHAN_HINT}`, status, error.retryAfterMs, {
      cause: error.cause,
    });
  }
  if (error instanceof ProviderError) {
    return new ProviderError(`${error.message}. ${ORPHAN_HINT}`, error.provider, {
      cause: error.cause,
    });
  }
  return error;
}

function isCredits(value: unknown): boolean {
  return (
    value === undefined ||
    (value !== null &&
      typeof value === "object" &&
      typeof (value as { credits?: unknown }).credits === "number")
  );
}

/** Reject create responses that do not carry a UUID task id. */
export function validateCreatedTask(value: unknown): RunwayCreatedTask {
  const task = value as RunwayCreatedTask | null;
  if (task === null || typeof task !== "object" || !isValidTaskId(task.id)) {
    throw new ProviderError("Malformed Runway response: missing or invalid task id", PROVIDER);
  }
  if (!isCredits(task.estimatedCost)) {
    throw new ProviderError("Malformed Runway response: invalid estimatedCost", PROVIDER);
  }
  return { id: task.id, estimatedCost: task.estimatedCost };
}

/** Reject task responses that are not task-shaped instead of trusting them. */
export function validateTask(value: unknown): RunwayTask {
  const task = value as RunwayTask | null;
  if (task === null || typeof task !== "object" || !isValidTaskId(task.id)) {
    throw new ProviderError("Malformed Runway response: missing or invalid task id", PROVIDER);
  }
  if (typeof task.status !== "string" || !STATUSES.has(task.status)) {
    throw new ProviderError("Malformed Runway response: unknown task status", PROVIDER);
  }
  if (!isCredits(task.estimatedCost) || !isCredits(task.cost)) {
    throw new ProviderError("Malformed Runway response: invalid cost", PROVIDER);
  }
  const present = (v: unknown) => v !== undefined && v !== null;
  if (
    (present(task.failure) && typeof task.failure !== "string") ||
    (present(task.failureCode) && typeof task.failureCode !== "string") ||
    (present(task.createdAt) && typeof task.createdAt !== "string") ||
    (present(task.progress) && typeof task.progress !== "number")
  ) {
    throw new ProviderError("Malformed Runway response: unexpected task field type", PROVIDER);
  }
  if (
    task.status === "SUCCEEDED" &&
    (!Array.isArray(task.output) ||
      task.output.length === 0 ||
      !task.output.every((u) => typeof u === "string" && u.length > 0))
  ) {
    throw new ProviderError("Malformed Runway response: succeeded task without output", PROVIDER);
  }
  return task;
}

/** Throw for FAILED/CANCELLED; return the task when it succeeded. */
export function assertSucceeded(task: RunwayTask): RunwayTask {
  if (task.status === "SUCCEEDED") return task;
  if (isTerminalStatus(task.status)) throw new RunwayTaskError(task);
  throw new ProviderError(
    `Runway task ${task.id} is not finished (status: ${task.status})`,
    PROVIDER,
  );
}

export interface RunwayClientOptions {
  apiKey: string;
  /** Defaults to https://api.dev.runwayml.com. */
  baseUrl?: string;
  /** Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Injectable for tests (429 retry back-off). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Slowest upload speed to allow for, in bytes per second. Create requests
   * can carry inline images of several MB, so their timeout grows with the
   * body size at this rate. Defaults to 1 MB/s.
   */
  minUploadBytesPerSec?: number;
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  maxIntervalMs?: number;
  /** Appended to the timeout message, e.g. a resume command. */
  resumeHint?: string;
  onPoll?: (task: RunwayTask, attempt: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface UploadOptions {
  data: Blob;
  filename: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RunwayClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minUploadBytesPerSec: number;

  constructor(opts: RunwayClientOptions) {
    if (!opts.apiKey) throw new ProviderError("Runway API secret is required", PROVIDER);
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_RUNWAY_BASE_URL).replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.minUploadBytesPerSec = opts.minUploadBytesPerSec ?? DEFAULT_MIN_UPLOAD_BYTES_PER_SEC;
  }

  /** Base timeout plus the time the body needs at the slowest allowed upload speed. */
  createTimeoutMs(body: unknown): number {
    const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
    return REQUEST_TIMEOUT_MS + Math.ceil((bytes / this.minUploadBytesPerSec) * 1000);
  }

  /** Raw request: throws HttpError so polling can classify transient failures. */
  private raw<T>(
    path: string,
    method: "GET" | "POST" | "DELETE",
    body?: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    return fetchJson<T>({
      url: `${this.baseUrl}${path}`,
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "x-runway-version": RUNWAY_API_VERSION,
      },
      body,
      timeoutMs,
      fetch: this.doFetch,
    }).catch((error: unknown) => {
      throw scrubSecret(error, this.apiKey);
    });
  }

  /** POST a generation request; retries only 429 (nothing was created). */
  private async create(path: string, body: { model: string }): Promise<RunwayCreatedTask> {
    const subject = `model ${body.model}`;
    const timeoutMs = this.createTimeoutMs(body);
    for (let attempt = 0; ; attempt++) {
      try {
        return validateCreatedTask(await this.raw<unknown>(path, "POST", body, timeoutMs));
      } catch (error) {
        if (error instanceof HttpError && error.status === 429 && attempt < CREATE_MAX_RETRIES) {
          const delay = Math.min(error.retryAfterMs ?? 2000 * (attempt + 1), CREATE_RETRY_CAP_MS);
          await this.sleep(delay);
          continue;
        }
        throw withOrphanHint(mapRunwayError(error, subject));
      }
    }
  }

  imageToVideo(request: ImageToVideoRequest): Promise<RunwayCreatedTask> {
    return this.create("/v1/image_to_video", request);
  }

  textToVideo(request: TextToVideoRequest): Promise<RunwayCreatedTask> {
    return this.create("/v1/text_to_video", request);
  }

  textToImage(request: TextToImageRequest): Promise<RunwayCreatedTask> {
    return this.create("/v1/text_to_image", request);
  }

  async getTask(id: string): Promise<RunwayTask> {
    const safeId = assertTaskId(id);
    try {
      return validateTask(await this.raw<unknown>(`/v1/tasks/${safeId}`, "GET"));
    } catch (error) {
      throw mapRunwayError(error, `task ${safeId}`);
    }
  }

  /**
   * DELETE /v1/tasks/{id}: cancels a PENDING/THROTTLED/RUNNING task, and
   * deletes a finished one together with its outputs. Callers check the
   * status first when deleting outputs would be a surprise.
   */
  async deleteTask(id: string): Promise<void> {
    const safeId = assertTaskId(id);
    try {
      await this.raw<unknown>(`/v1/tasks/${safeId}`, "DELETE");
    } catch (error) {
      throw mapRunwayError(error, `task ${safeId}`);
    }
  }

  /**
   * Poll until the task reaches SUCCEEDED, FAILED or CANCELLED and return it —
   * callers decide success via assertSucceeded. Retries network/408/429/5xx
   * (honouring Retry-After); throws PollTimeoutError on deadline.
   */
  async waitForTask(id: string, opts: WaitOptions): Promise<RunwayTask> {
    const safeId = assertTaskId(id);
    try {
      return await pollUntil<RunwayTask>({
        fetchStatus: async ({ remainingMs }) =>
          validateTask(
            await this.raw<unknown>(
              `/v1/tasks/${safeId}`,
              "GET",
              undefined,
              // AbortSignal.timeout needs a positive integer; clocks may be fractional.
              Math.max(1, Math.ceil(Math.min(REQUEST_TIMEOUT_MS, remainingMs))),
            ),
          ),
        isTerminal: (t) => isTerminalStatus(t.status),
        isTransientError: isTransientHttpError,
        timeoutMs: opts.timeoutMs,
        intervalMs: Math.max(MIN_POLL_INTERVAL_MS, opts.intervalMs ?? MIN_POLL_INTERVAL_MS),
        maxIntervalMs: opts.maxIntervalMs ?? 15_000,
        minIntervalMs: MIN_POLL_INTERVAL_MS,
        jitter: false,
        resumeHint: opts.resumeHint,
        onPoll: opts.onPoll,
        sleep: opts.sleep ?? this.sleep,
        now: opts.now,
      });
    } catch (error) {
      if (error instanceof PollTimeoutError) throw error;
      throw mapRunwayError(error, `task ${safeId}`);
    }
  }

  /**
   * Ephemeral upload: POST /v1/uploads for a presigned form, then POST the
   * file to that storage URL (no API key is sent there). Returns the
   * runway:// URI, usable in generation requests for 24 hours.
   */
  async uploadEphemeral(opts: UploadOptions): Promise<string> {
    const subject = `upload ${opts.filename}`;
    let ticket: RunwayUploadTicket;
    try {
      ticket = await this.raw<RunwayUploadTicket>("/v1/uploads", "POST", {
        filename: opts.filename,
        type: "ephemeral",
      });
    } catch (error) {
      throw mapRunwayError(error, subject);
    }
    if (
      typeof ticket?.uploadUrl !== "string" ||
      typeof ticket.runwayUri !== "string" ||
      !ticket.runwayUri.startsWith("runway://") ||
      ticket.fields === null ||
      typeof ticket.fields !== "object" ||
      !Object.values(ticket.fields).every((v) => typeof v === "string")
    ) {
      throw new ProviderError("Malformed Runway upload response", PROVIDER);
    }
    // The storage URL comes from the API; never post user files to a local or private address.
    checkUrlSafety(ticket.uploadUrl, { provider: PROVIDER, action: "upload to" });

    const form = new FormData();
    for (const [key, value] of Object.entries(ticket.fields)) form.append(key, value);
    form.append("file", opts.data, opts.filename);
    let response: Response;
    try {
      response = await this.doFetch(ticket.uploadUrl, {
        method: "POST",
        body: form,
        redirect: "manual",
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch (cause) {
      throw mapRunwayError(toFetchError(cause, ticket.uploadUrl, { provider: PROVIDER }), subject);
    }
    if (!response.ok) {
      throw mapRunwayError(await httpErrorFromResponse(response, ticket.uploadUrl), subject);
    }
    await response.body?.cancel().catch(() => {});
    return ticket.runwayUri;
  }
}
