/**
 * Direct Runway Dev API client (https://api.dev.runwayml.com).
 *
 * Runtime-neutral: no node:* imports, no env/logger/disk access. Callers pass
 * `apiKey`, optional `baseUrl`, and optional `fetch`, so the same client runs
 * in the Node CLI and in non-Node runtimes such as a Cloudflare Worker.
 *
 * - Every request sends `Authorization: Bearer` and a pinned `X-Runway-Version`.
 * - Creates are retried only on 429 (nothing was created). A network error,
 *   timeout, 5xx or unusable 2xx body on create may have started a billable
 *   task, so it is reported with a dashboard hint instead of being retried.
 * - Status reads poll with bounded backoff, retrying network/408/429/5xx and
 *   honouring Retry-After.
 * - Cancel (DELETE /v1/tasks/{id}) also deletes finished tasks, so the client
 *   reads the task first and refuses to delete a finished one unless asked.
 */

import { PollTimeoutError, isTransientHttpError, pollUntil } from "../../core/async-poll.js";
import { HttpError, ProviderError } from "../../core/errors.js";
import { toFetchError } from "../../core/fetch-error.js";
import { type FetchLike, fetchJson, httpErrorFromResponse } from "../../core/fetch-json.js";
import { checkUrlSafety } from "../../core/url-safety.js";
import {
  DEFAULT_RUNWAY_BASE_URL,
  KNOWN_STATUSES,
  RUNWAY_API_VERSION,
  RUNWAY_KEY_LINK,
  RUNWAY_TASKS_DASHBOARD,
  assertTaskId,
  isTerminalStatus,
  isValidTaskId,
} from "./models.js";
import type {
  RunwayCreatedTask,
  RunwayImageToVideoBody,
  RunwayTask,
  RunwayTextToImageBody,
  RunwayTextToVideoBody,
  RunwayUploadSlot,
} from "./types.js";

const PROVIDER = "runway";
const DETAIL_MAX = 300;
const CREATE_MAX_RETRIES = 2;
const CREATE_RETRY_CAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 300_000;

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

/** A task ended FAILED or CANCELLED — never a success. */
export class RunwayTaskError extends ProviderError {
  constructor(public readonly task: RunwayTask) {
    const code = task.failureCode ? ` [${task.failureCode}]` : "";
    const reason = task.failure ? `: ${String(task.failure).slice(0, DETAIL_MAX)}` : "";
    super(`Runway task ${task.id} ${task.status.toLowerCase()}${code}${reason}`, PROVIDER);
    this.name = "RunwayTaskError";
  }
}

/** Pull `error` (Runway's 400 body) or `detail`/`message` from a JSON body, else the raw snippet. */
function errorDetail(snippet: string): string {
  try {
    const body = JSON.parse(snippet) as Record<string, unknown>;
    const detail = body.error ?? body.detail ?? body.message;
    if (typeof detail === "string" && detail) return detail.slice(0, DETAIL_MAX);
    if (detail && typeof detail === "object") return JSON.stringify(detail).slice(0, DETAIL_MAX);
  } catch {
    // not JSON — fall through to the raw snippet
  }
  return snippet.trim().slice(0, DETAIL_MAX);
}

const CREDITS_RE = /credit|balance|billing/i;

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
    message = `Runway rejected the API secret (401). Check RUNWAYML_API_SECRET; create one at ${RUNWAY_KEY_LINK}`;
  } else if (status === 402 || (status === 400 && CREDITS_RE.test(detail))) {
    message = `Runway could not bill this request (${status})${suffix}. Add credits in the developer portal: ${RUNWAY_KEY_LINK}`;
  } else if (status === 403) {
    message = `Runway denied access to ${subject} (403)${suffix}`;
  } else if (status === 404) {
    message = subject.startsWith("task")
      ? `Runway could not find ${subject} (404); it may belong to another organization, or have been deleted or expired`
      : `Runway could not find ${subject} (404)${suffix}`;
  } else if (status === 400 || status === 422) {
    message = `Runway rejected the request for ${subject} (${status})${suffix}`;
  } else if (status === 429) {
    const wait =
      retryAfterMs !== undefined ? `; retry after ${Math.ceil(retryAfterMs / 1000)}s` : "";
    message = `Runway rate limit or concurrency limit reached (429)${wait}`;
  } else if (status >= 500) {
    message = `Runway server error (${status})${suffix}. Try again later`;
  } else {
    message = `Runway request for ${subject} failed (${status})${suffix}`;
  }
  return new RunwayApiError(message, status, retryAfterMs, { cause: error });
}

export const ORPHAN_HINT = `The task may have been created anyway (Runway has no idempotency key); check ${RUNWAY_TASKS_DASHBOARD} before retrying to avoid paying twice`;

/**
 * A network error, timeout, 5xx, or an unusable 2xx body on create can happen
 * after Runway has already created (and started billing) the task, leaving no
 * id to resume or cancel. Point the user at the dashboard before they retry.
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
    value !== null &&
    typeof value === "object" &&
    typeof (value as { credits?: unknown }).credits === "number" &&
    Number.isFinite((value as { credits: number }).credits)
  );
}

/** Reject create responses without a usable task id instead of trusting them. */
export function validateCreatedTask(value: unknown): RunwayCreatedTask {
  if (value === null || typeof value !== "object") {
    throw new ProviderError("Malformed Runway response: expected a task object", PROVIDER);
  }
  const { id, estimatedCost } = value as RunwayCreatedTask;
  // Server-supplied ids flow into URL paths, file names, and printed commands.
  if (!isValidTaskId(id)) {
    throw new ProviderError("Malformed Runway response: missing or invalid task id", PROVIDER);
  }
  return isCredits(estimatedCost) ? { id, estimatedCost } : { id };
}

/** Reject task responses that are not task-shaped instead of trusting them. */
export function validateTask(value: unknown): RunwayTask {
  if (value === null || typeof value !== "object") {
    throw new ProviderError("Malformed Runway response: expected a task object", PROVIDER);
  }
  const task = value as RunwayTask;
  if (!isValidTaskId(task.id)) {
    throw new ProviderError("Malformed Runway response: missing or invalid task id", PROVIDER);
  }
  if (!KNOWN_STATUSES.includes(task.status)) {
    throw new ProviderError(
      `Malformed Runway response: unknown task status ${JSON.stringify(String(task.status)).slice(0, 40)}`,
      PROVIDER,
    );
  }
  if (task.status === "SUCCEEDED") {
    const output = task.output;
    if (
      !Array.isArray(output) ||
      output.length === 0 ||
      !output.every((u) => typeof u === "string")
    ) {
      throw new ProviderError(
        `Malformed Runway response: task ${task.id} succeeded without output URLs`,
        PROVIDER,
      );
    }
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
  /** Injectable for tests (429 retry back-off, polling). */
  sleep?: (ms: number) => Promise<void>;
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
  contentType: string;
}

export type CancelResult =
  | { action: "cancelled"; task: RunwayTask }
  | { action: "deleted"; task: RunwayTask }
  | { action: "refused"; task: RunwayTask };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RunwayClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: RunwayClientOptions) {
    if (!opts.apiKey) throw new ProviderError("Runway API secret is required", PROVIDER);
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_RUNWAY_BASE_URL).replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/json",
      authorization: `Bearer ${this.apiKey}`,
      "x-runway-version": RUNWAY_API_VERSION,
    };
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
      headers: this.headers(),
      body,
      timeoutMs,
      fetch: this.doFetch,
    });
  }

  /** POST a create endpoint; retries only 429 (nothing was created). */
  private async create(path: string, body: { model: string }): Promise<RunwayCreatedTask> {
    const subject = `model ${body.model}`;
    for (let attempt = 0; ; attempt++) {
      try {
        return validateCreatedTask(await this.raw<unknown>(path, "POST", body));
      } catch (error) {
        if (error instanceof HttpError && error.status === 429 && attempt < CREATE_MAX_RETRIES) {
          const delay = Math.min(error.retryAfterMs ?? 2000 * 2 ** attempt, CREATE_RETRY_CAP_MS);
          await this.sleep(delay);
          continue;
        }
        throw withOrphanHint(mapRunwayError(error, subject));
      }
    }
  }

  createTextToVideo(body: RunwayTextToVideoBody): Promise<RunwayCreatedTask> {
    return this.create("/v1/text_to_video", body);
  }

  createImageToVideo(body: RunwayImageToVideoBody): Promise<RunwayCreatedTask> {
    return this.create("/v1/image_to_video", body);
  }

  createTextToImage(body: RunwayTextToImageBody): Promise<RunwayCreatedTask> {
    return this.create("/v1/text_to_image", body);
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
   * Cancel a PENDING/THROTTLED/RUNNING task. DELETE on a finished task deletes
   * it and its outputs, so that only happens with `allowDelete`; otherwise a
   * finished task is returned as `refused`.
   */
  async cancelTask(id: string, opts: { allowDelete?: boolean } = {}): Promise<CancelResult> {
    const safeId = assertTaskId(id);
    const task = await this.getTask(safeId);
    const finished = isTerminalStatus(task.status);
    if (finished && !opts.allowDelete) return { action: "refused", task };
    try {
      await this.raw<unknown>(`/v1/tasks/${safeId}`, "DELETE");
    } catch (error) {
      throw mapRunwayError(error, `task ${safeId}`);
    }
    return { action: finished ? "deleted" : "cancelled", task };
  }

  /**
   * Poll until the task reaches SUCCEEDED, FAILED or CANCELLED and return it —
   * callers decide success via assertSucceeded. Runway asks clients not to
   * poll more than once every five seconds.
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
        intervalMs: opts.intervalMs ?? 5000,
        maxIntervalMs: opts.maxIntervalMs ?? 15_000,
        minIntervalMs: 5000,
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
   * Ephemeral upload: POST /v1/uploads reserves a pre-signed form, the file
   * goes to that storage URL (no API key, no redirects), and the returned
   * runway:// URI can be used as a model input for 24 hours.
   */
  async uploadEphemeral(opts: UploadOptions): Promise<string> {
    const subject = `upload ${opts.filename}`;
    let slot: RunwayUploadSlot;
    try {
      slot = await this.raw<RunwayUploadSlot>("/v1/uploads", "POST", {
        filename: opts.filename,
        type: "ephemeral",
      });
    } catch (error) {
      throw mapRunwayError(error, subject);
    }
    if (
      !slot ||
      typeof slot.uploadUrl !== "string" ||
      typeof slot.runwayUri !== "string" ||
      !slot.runwayUri.startsWith("runway://") ||
      slot.fields === null ||
      typeof slot.fields !== "object"
    ) {
      throw new ProviderError("Malformed Runway upload response", PROVIDER);
    }
    // The storage URL comes from the API; never post user files to a private or plain-http host.
    checkUrlSafety(slot.uploadUrl, { provider: PROVIDER, action: "upload to" });

    const form = new FormData();
    for (const [key, value] of Object.entries(slot.fields)) {
      if (typeof value === "string") form.append(key, value);
    }
    const blob = opts.data.type ? opts.data : new Blob([opts.data], { type: opts.contentType });
    form.append("file", blob, opts.filename);

    let response: Response;
    try {
      response = await this.doFetch(slot.uploadUrl, {
        method: "POST",
        body: form,
        redirect: "manual",
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch (cause) {
      throw mapRunwayError(
        toFetchError(cause, slot.uploadUrl, { provider: PROVIDER, prefix: "File upload failed: " }),
        subject,
      );
    }
    if (!response.ok) {
      throw mapRunwayError(await httpErrorFromResponse(response, slot.uploadUrl), subject);
    }
    await response.body?.cancel().catch(() => {});
    return slot.runwayUri;
  }
}
