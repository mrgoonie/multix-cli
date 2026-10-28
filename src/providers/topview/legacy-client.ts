/**
 * TopView legacy API client (marketing video, avatars, product shots, uploads).
 * Runtime-neutral: no node:* imports; callers pass the key, the UID, an
 * optional base URL and fetch.
 *
 * API contract (https://docs.topview.ai/llms.txt):
 * - Auth: `Authorization: Bearer <key>` plus `Topview-Uid: <uid>`
 * - Envelope: `{ code: "200", message, result }`; any other code is an error
 *   (4100 "Credit not enough", 5003 "Server is busy", ...)
 * - Tasks: POST <kind>/submit -> result.taskId; GET <kind>/query?taskId= ->
 *   result.status init | running | success | fail
 * - Upload: GET /v1/upload/credential?format= -> signed S3 PUT -> GET /v1/upload/check
 * Credits are the topview.ai web plan's. No cancel endpoint is documented.
 */

import { isTransientHttpError, pollUntil } from "../../core/async-poll.js";
import { ConfigError, HttpError, ProviderError, ValidationError } from "../../core/errors.js";
import { toFetchError } from "../../core/fetch-error.js";
import {
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  fetchJson,
  httpErrorFromResponse,
} from "../../core/fetch-json.js";
import {
  DEFAULT_TOPVIEW_BASE_URL,
  LEGACY_TASKS,
  LEGACY_UPLOAD_FORMATS,
  type LegacyTaskKind,
  TOPVIEW_PROVIDER,
} from "./models.js";
import { parseJson, sendOnce, unknownRemoteState } from "./send-once.js";
import type {
  LegacyClientOptions,
  LegacyEnvelope,
  LegacyTask,
  LegacyUploadCredential,
  WaitOptions,
} from "./types.js";

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const UPLOAD_TIMEOUT_MS = 300_000;

/** Codes that are a definite refusal: nothing was created. */
const DEFINITE_SUBMIT_CODES = new Set(["5003", "6001"]);

export function assertValidTaskId(id: string): void {
  if (!TASK_ID_RE.test(id)) throw new ValidationError(`Invalid TopView task id: "${id}"`);
}

export function isLegacyTerminal(status: unknown): boolean {
  return status === "success" || status === "fail";
}

/**
 * True once a task needs no more polling. An export is read through its m2v
 * task, which is already `success` from the preview: it is done only once an
 * exported video reached a final state.
 */
export function isLegacyTaskDone(kind: LegacyTaskKind, task: LegacyTask): boolean {
  if (!isLegacyTerminal(task.status)) return false;
  if (kind !== "m2v-export" || task.status === "fail") return true;
  const exports = Array.isArray(task.exportVideos) ? task.exportVideos : [];
  return exports.some((v) => isLegacyTerminal((v as { status?: unknown } | null)?.status));
}

/** A legacy task ended in `fail`; carries the task payload. */
export class TopviewTaskFailedError extends ProviderError {
  constructor(public readonly task: LegacyTask) {
    super(
      `TopView task failed (${task.taskId}): ${task.errorMsg || `status "${task.status}"`}`,
      TOPVIEW_PROVIDER,
    );
    this.name = "TopviewTaskFailedError";
  }
}

/** Readable error for a non-200 envelope code; the wording drives the error class. */
export function legacyCodeError(code: string, message: string | undefined, what: string): Error {
  const detail = `code ${code}: ${message || "no message"}`;
  if (code === "4100") {
    return new ProviderError(
      `TopView ${what} refused: insufficient credit on the topview.ai plan (${detail})`,
      TOPVIEW_PROVIDER,
    );
  }
  if (code === "4002") {
    return new ProviderError(
      `TopView ${what} refused: authentication failed (${detail}); check TOPVIEW_API_KEY and TOPVIEW_UID`,
      TOPVIEW_PROVIDER,
    );
  }
  if (code === "4004") {
    return new ProviderError(`TopView ${what}: not found (${detail})`, TOPVIEW_PROVIDER);
  }
  return new ProviderError(`TopView ${what} failed (${detail})`, TOPVIEW_PROVIDER);
}

function codeOf(env: LegacyEnvelope<unknown>): string {
  return env.code === undefined ? "" : String(env.code);
}

/**
 * Result of a read (query, credential, check). A 5xxx code is TopView being
 * busy or failing internally, so it becomes HttpError 503 and polling retries it.
 */
function readResult<T>(env: LegacyEnvelope<T> | undefined, url: string, what: string): T {
  if (!env || typeof env !== "object") {
    throw new ProviderError(
      `TopView ${what}: response is not the documented envelope`,
      TOPVIEW_PROVIDER,
    );
  }
  const code = codeOf(env);
  if (code !== "200") {
    if (/^5\d{3}$/.test(code)) throw new HttpError(503, `code ${code}: ${env.message ?? ""}`, url);
    throw legacyCodeError(code, env.message, what);
  }
  if (env.result === undefined || env.result === null) {
    throw new ProviderError(`TopView ${what}: response has no result`, TOPVIEW_PROVIDER);
  }
  return env.result;
}

function legacyErrorMessage(text: string): string {
  const env = parseJson(text) as LegacyEnvelope<unknown> | undefined;
  if (env && typeof env === "object" && (env.code !== undefined || env.message)) {
    return `code ${codeOf(env) || "?"}: ${env.message ?? "no message"}`;
  }
  return text;
}

function isLegacyError(text: string): boolean {
  const env = parseJson(text) as LegacyEnvelope<unknown> | undefined;
  return Boolean(env && typeof env === "object" && env.code !== undefined);
}

export class TopviewLegacyClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly uid: string;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: LegacyClientOptions) {
    if (!opts.apiKey?.trim()) throw new ConfigError("TOPVIEW_API_KEY is not set");
    if (!opts.uid?.trim()) {
      throw new ConfigError("TOPVIEW_UID is not set; the legacy API needs it with TOPVIEW_API_KEY");
    }
    this.apiKey = opts.apiKey.trim();
    this.uid = opts.uid.trim();
    this.baseUrl = (opts.baseUrl?.trim() || DEFAULT_TOPVIEW_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Topview-Uid": this.uid,
      Accept: "application/json",
    };
  }

  /**
   * Submit a task once. Returns the task id. A definite refusal (4xxx, busy,
   * insufficient credit) throws a plain error; any outcome that may have
   * created the task throws UNKNOWN_REMOTE_STATE and is never resent.
   */
  async submit(kind: LegacyTaskKind, body: Record<string, unknown>): Promise<string> {
    const url = `${this.baseUrl}${LEGACY_TASKS[kind].submit}`;
    const what = `${kind} submit`;
    const advice =
      "check the task list on topview.ai before submitting again, or you may pay twice.";
    const text = await sendOnce({
      url,
      what,
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: this.timeoutMs,
      advice,
      isProviderError: isLegacyError,
      errorMessage: legacyErrorMessage,
      fetch: this.fetchImpl,
    });
    const env = parseJson(text) as LegacyEnvelope<Record<string, unknown>> | undefined;
    if (!env || typeof env !== "object" || env.code === undefined) {
      throw unknownRemoteState(what, "the response is not the documented envelope", advice);
    }
    const code = codeOf(env);
    if (code !== "200") {
      // 4xxx is a refusal; 5003 busy and 6001 security reject before work starts.
      if (code.startsWith("4") || DEFINITE_SUBMIT_CODES.has(code)) {
        throw legacyCodeError(code, env.message, what);
      }
      throw unknownRemoteState(what, `code ${code}: ${env.message ?? "no message"}`, advice);
    }
    const result = env.result ?? {};
    const taskId = result.taskId;
    if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId)) {
      throw unknownRemoteState(what, "the response carries no valid taskId", advice);
    }
    if (result.status === "fail") {
      throw new ProviderError(
        `TopView ${what} was rejected: ${String(result.errorMsg || "task failed")}`,
        TOPVIEW_PROVIDER,
      );
    }
    return taskId;
  }

  /** Read a task once. A 5xxx code is thrown as HttpError 503 (retried by polling). */
  async getTask(kind: LegacyTaskKind, taskId: string, timeoutMs?: number): Promise<LegacyTask> {
    assertValidTaskId(taskId);
    const url = `${this.baseUrl}${LEGACY_TASKS[kind].query}?taskId=${encodeURIComponent(taskId)}`;
    const env = await fetchJson<LegacyEnvelope<LegacyTask>>({
      url,
      headers: this.headers(),
      timeoutMs: timeoutMs ?? this.timeoutMs,
      fetch: this.fetchImpl,
    });
    const task = readResult(env, url, `${kind} query`);
    if (typeof task !== "object" || typeof task.status !== "string") {
      throw new ProviderError(
        `TopView ${kind} query: response has no task status (schema mismatch)`,
        TOPVIEW_PROVIDER,
      );
    }
    return { ...task, taskId: typeof task.taskId === "string" ? task.taskId : taskId };
  }

  /** Poll until success or fail; network errors, 429 (Retry-After), 5xx and busy codes are retried. */
  waitForTask(
    kind: LegacyTaskKind,
    taskId: string,
    opts: WaitOptions<LegacyTask>,
  ): Promise<LegacyTask> {
    assertValidTaskId(taskId);
    return pollUntil<LegacyTask>({
      fetchStatus: ({ remainingMs }) =>
        this.getTask(
          kind,
          taskId,
          Math.ceil(Math.max(1000, Math.min(this.timeoutMs, remainingMs))),
        ),
      isTerminal: (t) => isLegacyTaskDone(kind, t),
      timeoutMs: opts.timeoutMs,
      intervalMs: opts.intervalMs ?? 5000,
      maxIntervalMs: opts.maxIntervalMs ?? 20_000,
      isTransientError: isTransientHttpError,
      onPoll: opts.onPoll,
      resumeHint: opts.resumeHint,
      sleep: opts.sleep,
      now: opts.now,
    });
  }

  /** Step 1 of an upload: a file id and a signed S3 URL for `format`. */
  async uploadCredential(format: string): Promise<LegacyUploadCredential> {
    const ext = format.toLowerCase();
    if (!(LEGACY_UPLOAD_FORMATS as readonly string[]).includes(ext)) {
      throw new ValidationError(
        `TopView does not accept .${ext} uploads; allowed: ${LEGACY_UPLOAD_FORMATS.join(", ")}`,
      );
    }
    const url = `${this.baseUrl}/v1/upload/credential?format=${ext}`;
    const env = await fetchJson<LegacyEnvelope<LegacyUploadCredential>>({
      url,
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      fetch: this.fetchImpl,
    });
    const cred = readResult(env, url, "upload credential");
    if (
      typeof cred.fileId !== "string" ||
      !cred.fileId ||
      !/^https:\/\//i.test(cred.uploadUrl ?? "")
    ) {
      throw new ProviderError(
        "TopView upload credential has no fileId or https uploadUrl (schema mismatch)",
        TOPVIEW_PROVIDER,
      );
    }
    return cred;
  }

  /** Step 2: PUT the bytes to the signed URL. No TopView credentials are sent there. */
  async putUpload(uploadUrl: string, file: Blob): Promise<void> {
    const f = this.fetchImpl;
    let response: Response;
    try {
      const init: RequestInit = {
        method: "PUT",
        body: file,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        redirect: "error",
      };
      response = await (f ? f(uploadUrl, init) : globalThis.fetch(uploadUrl, init));
    } catch (cause) {
      throw toFetchError(cause, uploadUrl, {
        provider: TOPVIEW_PROVIDER,
        prefix: "Upload failed: ",
      });
    }
    if (!response.ok) throw await httpErrorFromResponse(response, uploadUrl);
    await response.body?.cancel().catch(() => {});
  }

  /** Step 3: TopView confirms it received the file. */
  async checkUpload(fileId: string): Promise<boolean> {
    const url = `${this.baseUrl}/v1/upload/check?fileId=${encodeURIComponent(fileId)}`;
    const env = await fetchJson<LegacyEnvelope<boolean>>({
      url,
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      fetch: this.fetchImpl,
    });
    return readResult(env, url, "upload check") === true;
  }

  /** Upload bytes through the three documented steps; returns the file id. */
  async uploadFile(file: Blob, format: string): Promise<string> {
    const cred = await this.uploadCredential(format);
    await this.putUpload(cred.uploadUrl, file);
    if (!(await this.checkUpload(cred.fileId))) {
      throw new ProviderError(
        `TopView did not confirm the upload of file ${cred.fileId}`,
        TOPVIEW_PROVIDER,
      );
    }
    return cred.fileId;
  }
}
