/**
 * TopView legacy API client (https://api.topview.ai), billed in credits.
 *
 * Runtime-neutral: no node:* imports, no env/logger/disk access. Callers pass
 * `apiKey`, `uid`, optional `baseUrl` and optional `fetch`.
 *
 * Every request sends `Authorization: Bearer <key>` and `Topview-Uid: <uid>`.
 * Every response is an envelope `{ code: "200", message, result }`; any other
 * code is an error (see LEGACY_ERROR_CODES). Submits have no idempotency key,
 * so they are never retried: an ambiguous failure carries a dashboard hint.
 *
 * Endpoints (https://docs.topview.ai/llms.txt). The marketing-page paths
 * /v1/url2video, /v1/materials2video, /v1/product_avatar/task/submit and
 * /v1/product_anyshoot are not in the reference and are not used; see
 * models.ts for the reference pages of the endpoints below.
 */

import { PollTimeoutError, isTransientHttpError, pollUntil } from "../../core/async-poll.js";
import { HttpError, ProviderError } from "../../core/errors.js";
import { toFetchError } from "../../core/fetch-error.js";
import { type FetchLike, fetchJson, httpErrorFromResponse } from "../../core/fetch-json.js";
import { checkUrlSafety } from "../../core/url-safety.js";
import {
  DEFAULT_TOPVIEW_BASE_URL,
  type LegacyKind,
  TOPVIEW_DASHBOARD_LINK,
  assertLegacyId,
  isLegacyId,
  isLegacyTerminal,
  normalizeLegacyStatus,
} from "./models.js";
import type {
  AnyshootSubmitRequest,
  CreditDetail,
  LegacySubmitted,
  LegacyTask,
  M2vSubmitRequest,
  M2vVideo,
  ProductImage2VideoSubmitRequest,
  ProductReplaceSubmitRequest,
  ReplaceImage,
  UploadTicket,
  VideoAvatarSubmitRequest,
} from "./types.js";

const PROVIDER = "topview";
const DETAIL_MAX = 300;
const REQUEST_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 600_000;
/** The docs recommend polling every 3-5 seconds. */
export const LEGACY_POLL_INTERVAL_MS = 3_000;
export const LEGACY_POLL_MAX_INTERVAL_MS = 5_000;

/** Documented envelope codes ("Response Code" page). */
export const LEGACY_ERROR_CODES: Readonly<Record<string, string>> = {
  "4000": "request parameter error",
  "4001": "request data format does not match",
  "4002": "request digital signature does not match",
  "4003": "a required parameter is missing",
  "4004": "resource not found",
  "4005": "name duplicated",
  "4006": "request refused",
  "4007": "an unfinished task exists; wait until the previous task is completed",
  "4100": "credit not enough",
  "5000": "internal server error",
  "5001": "internal service call failed",
  "5003": "server is busy, try again later",
  "5004": "I/O error",
  "5005": "unknown error",
  "6001": "security problem detected",
};

/** Envelope codes worth polling through: the server failed, the task did not. */
const RETRYABLE_POLL_CODES = new Set(["5000", "5001", "5003", "5004"]);

const SUBMIT_PATHS: Readonly<Record<LegacyKind, string>> = {
  m2v: "/v1/m2v/task/submit",
  "video-avatar": "/v1/video_avatar/task/submit",
  "remove-background": "/v1/common_task/remove_background/submit",
  "product-avatar-replace": "/v3/product_avatar/task/image_replace/submit",
  "product-avatar-video": "/v3/product_avatar/task/image2Video/submit",
  "product-anyshoot": "/v1/product_anyShoot/task/submit",
};

const QUERY_PATHS: Readonly<Record<LegacyKind, string>> = {
  m2v: "/v1/m2v/task/query",
  "video-avatar": "/v1/video_avatar/task/query",
  "remove-background": "/v1/common_task/remove_background/query",
  "product-avatar-replace": "/v3/product_avatar/task/image_replace/query",
  "product-avatar-video": "/v3/product_avatar/task/image2Video/query",
  "product-anyshoot": "/v1/product_anyShoot/task/result",
};

/** Legacy API error. `status` is the HTTP status; `code` the envelope code, when there was one. */
export class TopviewApiError extends ProviderError {
  constructor(
    message: string,
    public readonly status: number,
    /** Envelope code ("4100", ...), when the failure came in an envelope. */
    public readonly apiCode?: string,
    public readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, PROVIDER, options);
    this.name = "TopviewApiError";
  }
}

/** A legacy task ended in `fail` — never a success. */
export class TopviewTaskError extends ProviderError {
  constructor(public readonly task: LegacyTask) {
    const detail = task.errorMsg ? `: ${task.errorMsg.slice(0, DETAIL_MAX)}` : "";
    super(`TopView ${task.kind} task ${task.taskId} failed${detail}`, PROVIDER);
    this.name = "TopviewTaskError";
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

/** `error` or `message` from a JSON error body, else the raw snippet. */
function errorDetail(snippet: string): string {
  try {
    const body = record(JSON.parse(snippet));
    const text = str(body?.error) ?? str(body?.message) ?? str(body?.errorMsg);
    if (text) return text.slice(0, DETAIL_MAX);
  } catch {
    // not JSON — fall through to the raw snippet
  }
  return snippet.trim().slice(0, DETAIL_MAX);
}

/** Map an HTTP failure to an actionable TopviewApiError; other errors pass through. */
export function mapTopviewHttpError(error: unknown, subject: string): unknown {
  if (!(error instanceof HttpError)) return error;
  const detail = errorDetail(error.snippet);
  const suffix = detail ? `: ${detail}` : "";
  const { status, retryAfterMs } = error;
  let message: string;
  if (status === 0) {
    message = `Network error contacting TopView${suffix}`;
  } else if (status === 401) {
    message = `TopView rejected the credentials (401)${suffix}. Check TOPVIEW_API_KEY and TOPVIEW_UID (API Settings at ${TOPVIEW_DASHBOARD_LINK})`;
  } else if (status === 403) {
    message = `TopView denied access to ${subject} (403)${suffix}`;
  } else if (status === 404) {
    message = `TopView could not find ${subject} (404)${suffix}`;
  } else if (status === 429) {
    const wait =
      retryAfterMs !== undefined ? `; retry after ${Math.ceil(retryAfterMs / 1000)}s` : "";
    message = `TopView rate limit reached (429)${wait}`;
  } else if (status >= 500) {
    message = `TopView server error (${status})${suffix}. Try again later`;
  } else {
    message = `TopView request for ${subject} failed (${status})${suffix}`;
  }
  return new TopviewApiError(message, status, undefined, retryAfterMs, { cause: error });
}

/**
 * A proxy may echo the Authorization header in its error body. Rebuild such
 * an HttpError without the key before anything maps, stores or prints it.
 */
export function scrubSecret(error: unknown, secret: string): unknown {
  if (!(error instanceof HttpError) || !secret || !error.snippet.includes(secret)) return error;
  const snippet = error.snippet.split(secret).join("[redacted]");
  return new HttpError(error.status, snippet, error.rawUrl, error.retryAfterMs);
}

/**
 * Check the envelope and return `result`. Success is code "200" (a number is
 * accepted too); any other code becomes a TopviewApiError naming it.
 */
export function unwrapEnvelope(body: unknown, subject: string): unknown {
  const envelope = record(body);
  if (!envelope || !("code" in envelope)) {
    throw new TopviewApiError(
      `Malformed TopView response for ${subject}: missing envelope code`,
      200,
    );
  }
  const code = String(envelope.code).trim();
  if (code === "200") return envelope.result;
  const known = LEGACY_ERROR_CODES[code];
  const message = str(envelope.message)?.slice(0, DETAIL_MAX);
  const what = [known, message && message.toLowerCase() !== known ? message : undefined]
    .filter(Boolean)
    .join(" — ");
  const hint =
    code === "4100" ? `. Top up credits at ${TOPVIEW_DASHBOARD_LINK} (API credits only)` : "";
  throw new TopviewApiError(
    `TopView rejected ${subject} (code ${code}${what ? `: ${what}` : ""})${hint}`,
    200,
    code,
  );
}

export const ORPHAN_HINT = `The task may have been created (and charged) anyway; check your TopView tasks and credit logs at ${TOPVIEW_DASHBOARD_LINK} before retrying to avoid paying twice`;

/**
 * A network error, timeout, 5xx, server-side envelope code or an unusable 2xx
 * body on submit can happen after TopView created the task. Say so.
 */
function withOrphanHint(error: unknown): unknown {
  if (!(error instanceof TopviewApiError)) {
    if (error instanceof ProviderError && !(error instanceof TopviewTaskError)) {
      return new ProviderError(`${error.message}. ${ORPHAN_HINT}`, PROVIDER, {
        cause: error.cause,
      });
    }
    return error;
  }
  const { status, apiCode: code } = error;
  const serverCode = code?.startsWith("5") === true;
  const mayExist =
    status === 0 || status >= 500 || serverCode || (status === 200 && code === undefined);
  if (!mayExist) return error;
  return new TopviewApiError(`${error.message}. ${ORPHAN_HINT}`, status, code, error.retryAfterMs, {
    cause: error.cause,
  });
}

function m2vVideos(value: unknown): M2vVideo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    const v = record(item) ?? {};
    const scriptId =
      typeof v.scriptId === "number" || typeof v.scriptId === "string" ? v.scriptId : undefined;
    return {
      ...(scriptId !== undefined ? { scriptId } : {}),
      status: normalizeLegacyStatus(v.status),
      ...(str(v.title) ? { title: v.title as string } : {}),
      ...(isHttpUrl(v.videoUrl) ? { videoUrl: (v.videoUrl as string).trim() } : {}),
      ...(num(v.videoDuration) !== undefined ? { videoDuration: num(v.videoDuration) } : {}),
    };
  });
}

/** True while any m2v preview or export is still being produced. */
function m2vBusy(videos: M2vVideo[] | undefined): boolean {
  return (videos ?? []).some((v) => v.status === "init" || v.status === "running");
}

/**
 * Normalize a query `result` for one kind. Unknown fields are ignored; a
 * missing or unknown status stays non-terminal so polling continues.
 */
export function normalizeTask(kind: LegacyKind, taskId: string, raw: unknown): LegacyTask {
  const r = record(raw);
  if (!r) throw new ProviderError(`Malformed TopView ${kind} response: missing result`, PROVIDER);
  const task: LegacyTask = {
    kind,
    taskId: isLegacyId(r.taskId) ? r.taskId : taskId,
    status: normalizeLegacyStatus(r.status),
    outputs: [],
  };
  const errorMsg = str(r.errorMsg);
  if (errorMsg) task.errorMsg = errorMsg;
  const cost = num(r.costCredit);
  if (cost !== undefined) task.costCredit = cost;

  switch (kind) {
    case "m2v": {
      task.previewVideos = m2vVideos(r.previewVideos);
      task.exportVideos = m2vVideos(r.exportVideos);
      const exported = (task.exportVideos ?? []).filter((v) => v.status === "success");
      const previews = (task.previewVideos ?? []).filter((v) => v.status === "success");
      task.outputs = (exported.length > 0 ? exported : previews)
        .map((v) => v.videoUrl)
        .filter((u): u is string => u !== undefined);
      // The task is finished only when no preview or export is still rendering.
      if (
        task.status === "success" &&
        (m2vBusy(task.previewVideos) || m2vBusy(task.exportVideos))
      ) {
        task.status = "running";
      }
      break;
    }
    case "video-avatar":
      if (isHttpUrl(r.outputVideoUrl)) task.outputs = [r.outputVideoUrl.trim()];
      break;
    case "remove-background": {
      if (isLegacyId(r.bgRemovedImageFileId)) task.bgRemovedImageFileId = r.bgRemovedImageFileId;
      if (isLegacyId(r.maskImageFileId)) task.maskImageFileId = r.maskImageFileId;
      if (isHttpUrl(r.bgRemovedImagePath)) task.outputs = [r.bgRemovedImagePath.trim()];
      break;
    }
    case "product-avatar-replace": {
      const images: ReplaceImage[] = Array.isArray(r.replaceProductResult)
        ? r.replaceProductResult.map((item) => {
            const i = record(item) ?? {};
            return {
              ...(str(i.imageId) ? { imageId: String(i.imageId) } : {}),
              ...(str(i.fileId) ? { fileId: String(i.fileId) } : {}),
              ...(isHttpUrl(i.url) ? { url: (i.url as string).trim() } : {}),
              ...(typeof i.faceExistence === "boolean" ? { faceExistence: i.faceExistence } : {}),
            };
          })
        : [];
      task.images = images;
      task.outputs = images.map((i) => i.url).filter((u): u is string => u !== undefined);
      break;
    }
    case "product-avatar-video": {
      // The reference spells the key with a trailing space ("finishedVideoUrl ").
      const url = r.finishedVideoUrl ?? r["finishedVideoUrl "];
      if (isHttpUrl(url)) task.outputs = [url.trim()];
      break;
    }
    case "product-anyshoot": {
      const images = Array.isArray(r.anyfitImages) ? r.anyfitImages : [];
      task.outputs = images
        .map((item) => record(item)?.url)
        .filter(isHttpUrl)
        .map((u) => u.trim());
      break;
    }
  }
  return task;
}

/** Throw for `fail`; return the task when it succeeded. */
export function assertTaskSucceeded(task: LegacyTask): LegacyTask {
  if (task.status === "success") return task;
  if (task.status === "fail") throw new TopviewTaskError(task);
  throw new ProviderError(
    `TopView ${task.kind} task ${task.taskId} is not finished (status: ${task.status})`,
    PROVIDER,
  );
}

/** m2v exports of one script (or all), as produced by `POST /v1/m2v/export`. */
export function exportsOf(task: LegacyTask, scriptId?: string): M2vVideo[] {
  return (task.exportVideos ?? []).filter(
    (v) => scriptId === undefined || String(v.scriptId) === scriptId,
  );
}

export interface TopviewClientOptions {
  apiKey: string;
  uid: string;
  /** Defaults to https://api.topview.ai. */
  baseUrl?: string;
  /** Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export interface LegacyWaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  maxIntervalMs?: number;
  /** Appended to the timeout message, e.g. a resume command. */
  resumeHint?: string;
  /** Override the terminal check (m2v export waits for its export entry). */
  isDone?: (task: LegacyTask) => boolean;
  onPoll?: (task: LegacyTask, attempt: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Network/408/429/5xx, or a server-side envelope code while polling. */
export function isTransientLegacyError(error: unknown): boolean {
  if (isTransientHttpError(error)) return true;
  return (
    error instanceof TopviewApiError &&
    error.apiCode !== undefined &&
    RETRYABLE_POLL_CODES.has(error.apiCode)
  );
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TopviewClient {
  private readonly apiKey: string;
  private readonly uid: string;
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: TopviewClientOptions) {
    if (!opts.apiKey) throw new ProviderError("TopView API key is required", PROVIDER);
    if (!opts.uid) throw new ProviderError("TopView UID is required", PROVIDER);
    this.apiKey = opts.apiKey;
    this.uid = opts.uid;
    this.baseUrl = (opts.baseUrl || DEFAULT_TOPVIEW_BASE_URL).replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** One request: returns the envelope `result`; throws HttpError or TopviewApiError. */
  private async request(
    path: string,
    method: "GET" | "POST",
    subject: string,
    body?: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const raw = await fetchJson<unknown>({
      url: `${this.baseUrl}${path}`,
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "topview-uid": this.uid,
      },
      body,
      timeoutMs,
      fetch: this.doFetch,
    }).catch((error: unknown) => {
      throw scrubSecret(error, this.apiKey);
    });
    return unwrapEnvelope(raw, subject);
  }

  /** Submit one task. Never retried: there is no idempotency key. */
  async submit(
    kind: LegacyKind,
    body:
      | M2vSubmitRequest
      | VideoAvatarSubmitRequest
      | { productImageFileId: string }
      | ProductReplaceSubmitRequest
      | ProductImage2VideoSubmitRequest
      | AnyshootSubmitRequest,
  ): Promise<LegacySubmitted> {
    const subject = `the ${kind} task`;
    try {
      const result = record(await this.request(SUBMIT_PATHS[kind], "POST", subject, body));
      return this.checkSubmitted(kind, result);
    } catch (error) {
      throw withOrphanHint(mapTopviewHttpError(error, subject));
    }
  }

  private checkSubmitted(kind: LegacyKind, result: Record<string, unknown> | undefined) {
    if (!result || !isLegacyId(result.taskId)) {
      throw new ProviderError(`Malformed TopView ${kind} response: missing task id`, PROVIDER);
    }
    const status = normalizeLegacyStatus(result.status);
    if (status === "fail") {
      const task: LegacyTask = { kind, taskId: result.taskId, status, outputs: [] };
      const msg = str(result.errorMsg);
      if (msg) task.errorMsg = msg;
      throw new TopviewTaskError(task);
    }
    return { taskId: result.taskId, status };
  }

  submitM2v(body: M2vSubmitRequest): Promise<LegacySubmitted> {
    return this.submit("m2v", body);
  }

  /** POST /v1/m2v/export: render the final video of one script (5 credits once exported). */
  async exportM2v(taskId: string, scriptId?: string): Promise<LegacySubmitted> {
    const id = assertLegacyId(taskId);
    const subject = `the export of m2v task ${id}`;
    try {
      const result = record(
        await this.request("/v1/m2v/export", "POST", subject, {
          taskId: id,
          ...(scriptId !== undefined ? { scriptId } : {}),
        }),
      );
      return this.checkSubmitted("m2v", { ...result, taskId: result?.taskId ?? id });
    } catch (error) {
      throw withOrphanHint(mapTopviewHttpError(error, subject));
    }
  }

  async getTask(kind: LegacyKind, taskId: string): Promise<LegacyTask> {
    const id = assertLegacyId(taskId);
    try {
      return await this.fetchTask(kind, id);
    } catch (error) {
      throw mapTopviewHttpError(error, `${kind} task ${id}`);
    }
  }

  private async fetchTask(kind: LegacyKind, id: string, timeoutMs = REQUEST_TIMEOUT_MS) {
    const query = new URLSearchParams({ taskId: id });
    const result = await this.request(
      `${QUERY_PATHS[kind]}?${query}`,
      "GET",
      `${kind} task ${id}`,
      undefined,
      timeoutMs,
    );
    return normalizeTask(kind, id, result);
  }

  /**
   * Poll until the task is terminal (or `isDone`), and return it — callers
   * decide success. Retries network/408/429/5xx and server envelope codes;
   * throws PollTimeoutError on the deadline.
   */
  async waitForTask(
    kind: LegacyKind,
    taskId: string,
    opts: LegacyWaitOptions,
  ): Promise<LegacyTask> {
    const id = assertLegacyId(taskId);
    const isDone = opts.isDone ?? ((t: LegacyTask) => isLegacyTerminal(t.status));
    try {
      return await pollUntil<LegacyTask>({
        fetchStatus: ({ remainingMs }) =>
          this.fetchTask(
            kind,
            id,
            Math.max(1, Math.ceil(Math.min(REQUEST_TIMEOUT_MS, remainingMs))),
          ),
        isTerminal: isDone,
        isTransientError: isTransientLegacyError,
        timeoutMs: opts.timeoutMs,
        intervalMs: opts.intervalMs ?? LEGACY_POLL_INTERVAL_MS,
        maxIntervalMs: opts.maxIntervalMs ?? LEGACY_POLL_MAX_INTERVAL_MS,
        minIntervalMs: 1_000,
        jitter: false,
        resumeHint: opts.resumeHint,
        onPoll: opts.onPoll,
        sleep: opts.sleep ?? this.sleep,
        now: opts.now,
      });
    } catch (error) {
      if (error instanceof PollTimeoutError) throw error;
      throw mapTopviewHttpError(error, `${kind} task ${id}`);
    }
  }

  /**
   * Upload a local file: GET /v1/upload/credential for a presigned URL, PUT
   * the bytes there (no API key; the URL must be a public https address),
   * then GET /v1/upload/check. Returns the fileId for task inputs.
   */
  async uploadFile(opts: { data: Blob; format: string; name: string }): Promise<string> {
    const subject = `upload of ${opts.name}`;
    let ticket: UploadTicket;
    try {
      const query = new URLSearchParams({ format: opts.format });
      const result = record(await this.request(`/v1/upload/credential?${query}`, "GET", subject));
      if (!result || !isLegacyId(result.fileId) || typeof result.uploadUrl !== "string") {
        throw new ProviderError("Malformed TopView upload credential response", PROVIDER);
      }
      ticket = { fileId: result.fileId, uploadUrl: result.uploadUrl };
    } catch (error) {
      throw mapTopviewHttpError(error, subject);
    }
    // The storage URL comes from the API; never send user files to a local or private address.
    checkUrlSafety(ticket.uploadUrl, { provider: PROVIDER, action: "upload to" });

    let response: Response;
    try {
      response = await this.doFetch(ticket.uploadUrl, {
        method: "PUT",
        body: opts.data,
        redirect: "manual",
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch (cause) {
      throw mapTopviewHttpError(
        toFetchError(cause, ticket.uploadUrl, { provider: PROVIDER }),
        subject,
      );
    }
    if (!response.ok) {
      throw mapTopviewHttpError(await httpErrorFromResponse(response, ticket.uploadUrl), subject);
    }
    await response.body?.cancel().catch(() => {});

    try {
      const query = new URLSearchParams({ fileId: ticket.fileId });
      const ok = await this.request(`/v1/upload/check?${query}`, "GET", subject);
      if (ok !== true && ok !== "true") {
        throw new ProviderError(
          `TopView did not confirm the upload of ${opts.name} (fileId ${ticket.fileId})`,
          PROVIDER,
        );
      }
    } catch (error) {
      throw mapTopviewHttpError(error, subject);
    }
    return ticket.fileId;
  }

  /**
   * GET /user/credit/detail. Returns the remaining credits and their expiry
   * only: the response also lists the account's API keys, which are dropped.
   */
  async getCredits(): Promise<CreditDetail> {
    try {
      const result = record(await this.request("/user/credit/detail", "GET", "credit detail"));
      if (!result) throw new ProviderError("Malformed TopView credit response", PROVIDER);
      const detail: CreditDetail = {};
      const remain = num(result.remainCredit);
      if (remain !== undefined) detail.remainCredit = remain;
      if (typeof result.expiredTime === "string" || typeof result.expiredTime === "number") {
        detail.expiredTime = result.expiredTime;
      }
      return detail;
    } catch (error) {
      throw mapTopviewHttpError(error, "credit detail");
    }
  }
}
