/**
 * TopView Legacy API client (https://api.topview.ai, docs.topview.ai).
 *
 * Runtime-neutral: no node:* imports, no env/logger/disk access. Callers pass
 * `apiKey`, `uid`, optional `baseUrl` and optional `fetch`.
 *
 * - Auth: `Authorization: Bearer <key>` and `Topview-Uid: <uid>` on every call.
 * - Envelope: `{ code: "200", message, result }`; any other code is an error.
 * - Submits have no idempotency key and there is no cancel endpoint, so only a
 *   429 (nothing created) is retried; any other ambiguous failure carries a
 *   hint to check the credit log before retrying.
 * - Uploads: GET /v1/upload/credential → PUT the bytes to the presigned URL
 *   (no TopView headers) → GET /v1/upload/check → fileId.
 */

import { PollTimeoutError, isTransientHttpError, pollUntil } from "../../core/async-poll.js";
import { HttpError, ProviderError } from "../../core/errors.js";
import { toFetchError } from "../../core/fetch-error.js";
import { type FetchLike, fetchJson, httpErrorFromResponse } from "../../core/fetch-json.js";
import { checkUrlSafety } from "../../core/url-safety.js";
import {
  PROVIDER,
  TopviewApiError,
  legacyBusinessError,
  mapLegacyError,
  scrubSecret,
  withLegacyOrphanHint,
} from "./errors.js";
import {
  DEFAULT_TOPVIEW_BASE_URL,
  LEGACY_TASK_KINDS,
  assertLegacyId,
  isLegacyTerminalStatus,
  isValidLegacyId,
  parseCredit,
} from "./models.js";
import type {
  LegacyCreditDetail,
  LegacyOutput,
  LegacySubmitted,
  LegacyTask,
  LegacyTaskKind,
  M2vVideo,
  ReplaceProductImage,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 60_000;
const SUBMIT_MAX_RETRIES = 2;
const SUBMIT_RETRY_CAP_MS = 30_000;
/** Slowest uplink an upload allows for before timing out (1 MB/s). */
const DEFAULT_MIN_UPLOAD_BYTES_PER_SEC = 1_000_000;
/** The docs suggest polling every 3-5 seconds. */
const MIN_POLL_INTERVAL_MS = 3_000;
const RECENT_TASKS_MAX = 20;

export interface TopviewLegacyClientOptions {
  apiKey: string;
  /** Topview Uid (account identifier, sent as the Topview-Uid header). */
  uid: string;
  /** Defaults to https://api.topview.ai. */
  baseUrl?: string;
  /** Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Injectable for tests (429 retry back-off). */
  sleep?: (ms: number) => Promise<void>;
  /** Slowest upload speed to allow for, in bytes per second. Defaults to 1 MB/s. */
  minUploadBytesPerSec?: number;
}

export interface LegacyWaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  maxIntervalMs?: number;
  /** Finished when this returns true (default: a terminal status, see isLegacyTaskDone). */
  isDone?: (task: LegacyTask) => boolean;
  /** Appended to the timeout message, e.g. a resume command. */
  resumeHint?: string;
  onPoll?: (task: LegacyTask, attempt: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface LegacyUploadOptions {
  data: Blob;
  /** Upload format without the dot (png, mp4, mp3, ...). */
  format: string;
  /** For messages only. */
  filename: string;
}

type Json = Record<string, unknown>;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function asRecord(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function httpUrl(value: unknown): string | undefined {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim()) ? value.trim() : undefined;
}

function malformed(what: string): ProviderError {
  return new ProviderError(`Malformed TopView response: ${what}`, PROVIDER);
}

function m2vVideos(list: unknown, type: M2vVideo["type"]): M2vVideo[] {
  if (!Array.isArray(list)) return [];
  const out: M2vVideo[] = [];
  for (const item of list) {
    const v = asRecord(item);
    if (!v) continue;
    const scriptId = parseCredit(v.scriptId);
    const duration = parseCredit(v.videoDuration);
    out.push({
      type,
      ...(scriptId !== undefined ? { scriptId } : {}),
      ...(str(v.status) ? { status: v.status as string } : {}),
      ...(str(v.title) ? { title: v.title as string } : {}),
      ...(httpUrl(v.videoUrl) ? { videoUrl: httpUrl(v.videoUrl) } : {}),
      ...(duration !== undefined ? { videoDuration: duration } : {}),
    });
  }
  return out;
}

function imageOutputs(list: unknown, prefix: string): LegacyOutput[] {
  if (!Array.isArray(list)) return [];
  const out: LegacyOutput[] = [];
  list.forEach((item, i) => {
    const url = httpUrl(asRecord(item)?.url);
    if (url) out.push({ url, label: `${prefix}-${i + 1}` });
  });
  return out;
}

/**
 * Normalise a query `result` of any legacy task kind. Tolerates the documented
 * inconsistencies: costCredit as a number or numeric string, and the
 * image2Video key `"finishedVideoUrl "` with a trailing space.
 */
export function parseLegacyTask(
  kind: LegacyTaskKind,
  value: unknown,
  requestedId: string,
): LegacyTask {
  const r = asRecord(value);
  if (!r) throw malformed(`${kind} query has no result`);
  if (typeof r.status !== "string" || r.status.trim() === "") {
    throw malformed(`${kind} task without a status`);
  }
  const taskId = isValidLegacyId(r.taskId) ? r.taskId : requestedId;
  const task: LegacyTask = { kind, taskId, status: r.status.trim(), outputs: [] };
  const errorMsg = str(r.errorMsg);
  if (errorMsg) task.errorMsg = errorMsg;
  const cost = parseCredit(r.costCredit);
  if (cost !== undefined) task.costCredit = cost;

  switch (kind) {
    case "m2v": {
      const exports = m2vVideos(r.exportVideos, "export");
      const previews = m2vVideos(r.previewVideos, "preview");
      task.videos = [...exports, ...previews];
      const ready = (v: M2vVideo) =>
        v.videoUrl && (v.status === undefined || v.status === "success");
      const chosen = exports.some(ready) ? exports : previews;
      for (const v of chosen.filter(ready)) {
        task.outputs.push({
          url: v.videoUrl as string,
          label: `${v.type}${v.scriptId !== undefined ? `-${v.scriptId}` : ""}`,
        });
      }
      break;
    }
    case "video-avatar": {
      const url = httpUrl(r.outputVideoUrl);
      if (url) task.outputs.push({ url, label: "video" });
      break;
    }
    case "remove-bg": {
      if (isValidLegacyId(r.bgRemovedImageFileId))
        task.bgRemovedImageFileId = r.bgRemovedImageFileId;
      if (isValidLegacyId(r.maskImageFileId)) task.maskImageFileId = r.maskImageFileId;
      const noBg = httpUrl(r.bgRemovedImagePath);
      const mask = httpUrl(r.maskImagePath);
      if (noBg) task.outputs.push({ url: noBg, label: "no-bg" });
      if (mask) task.outputs.push({ url: mask, label: "mask" });
      break;
    }
    case "product-avatar-replace": {
      const results: ReplaceProductImage[] = [];
      const list = Array.isArray(r.replaceProductResult) ? r.replaceProductResult : [];
      for (const item of list) {
        const x = asRecord(item);
        if (!x || !isValidLegacyId(x.imageId)) continue;
        const url = httpUrl(x.url);
        results.push({
          imageId: x.imageId,
          ...(isValidLegacyId(x.fileId) ? { fileId: x.fileId } : {}),
          ...(url ? { url } : {}),
          ...(typeof x.faceExistence === "boolean" ? { faceExistence: x.faceExistence } : {}),
        });
      }
      task.replaceResults = results;
      results.forEach((x, i) => {
        if (x.url) task.outputs.push({ url: x.url, label: `image-${i + 1}` });
      });
      break;
    }
    case "product-avatar-video": {
      const url = httpUrl(r.finishedVideoUrl) ?? httpUrl(r["finishedVideoUrl "]);
      if (url) task.outputs.push({ url, label: "video" });
      break;
    }
    case "anyshoot-try-on":
    case "anyshoot-background":
      task.outputs.push(...imageOutputs(r.anyfitImages, "image"));
      break;
  }
  return task;
}

/**
 * Finished for the CLI: `fail`, or `success` with no m2v video still being
 * rendered (an export submitted after a preview keeps the task "success"
 * while its export video is init/running).
 */
export function isLegacyTaskDone(task: LegacyTask): boolean {
  if (!isLegacyTerminalStatus(task.status)) return false;
  if (task.status === "fail") return true;
  return !(task.videos ?? []).some((v) => v.status === "init" || v.status === "running");
}

/** Reject a non-envelope body; turn a non-"200" code into an actionable error. */
export function unwrapLegacy(json: unknown, subject: string): unknown {
  const body = asRecord(json);
  if (!body || (typeof body.code !== "string" && typeof body.code !== "number")) {
    throw malformed(`no {code, result} envelope for ${subject}`);
  }
  const code = String(body.code).trim();
  if (code === "200") return body.result;
  throw legacyBusinessError(
    code,
    typeof body.message === "string" ? body.message : undefined,
    subject,
  );
}

export class TopviewLegacyClient {
  private readonly apiKey: string;
  private readonly uid: string;
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minUploadBytesPerSec: number;

  constructor(opts: TopviewLegacyClientOptions) {
    if (!opts.apiKey?.trim()) throw new ProviderError("TopView API key is required", PROVIDER);
    if (!opts.uid?.trim()) throw new ProviderError("TopView Uid is required", PROVIDER);
    this.apiKey = opts.apiKey.trim();
    this.uid = opts.uid.trim();
    this.baseUrl = (opts.baseUrl || DEFAULT_TOPVIEW_BASE_URL).replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.minUploadBytesPerSec = opts.minUploadBytesPerSec ?? DEFAULT_MIN_UPLOAD_BYTES_PER_SEC;
  }

  /** Raw request: throws HttpError (secret scrubbed) so polling can classify transient failures. */
  private raw(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
    return fetchJson<unknown>({
      url: `${this.baseUrl}${path}${qs}`,
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "Topview-Uid": this.uid,
      },
      body: opts.body,
      timeoutMs: opts.timeoutMs ?? REQUEST_TIMEOUT_MS,
      fetch: this.doFetch,
    }).catch((error: unknown) => {
      throw scrubSecret(error, this.apiKey);
    });
  }

  /** A read call: unwrap the envelope and map failures. */
  private async read(
    path: string,
    subject: string,
    query?: Record<string, string>,
  ): Promise<unknown> {
    try {
      return unwrapLegacy(await this.raw("GET", path, { query }), subject);
    } catch (error) {
      throw mapLegacyError(error, subject);
    }
  }

  /**
   * POST a paid task. Retries only a 429 (rejected before anything was
   * created); every other failure that may have created the task gets the
   * orphan hint. `resumeHint` is appended to it (e.g. how to resume a chain).
   */
  async submit(
    path: string,
    body: Json,
    subject: string,
    resumeHint?: string,
  ): Promise<LegacySubmitted> {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = asRecord(unwrapLegacy(await this.raw("POST", path, { body }), subject));
        if (!result || !isValidLegacyId(result.taskId)) {
          throw malformed(`missing or invalid taskId for ${subject}`);
        }
        return {
          taskId: result.taskId,
          ...(str(result.status) ? { status: result.status as string } : {}),
        };
      } catch (error) {
        if (error instanceof HttpError && error.status === 429 && attempt < SUBMIT_MAX_RETRIES) {
          const delay = Math.min(error.retryAfterMs ?? 2000 * (attempt + 1), SUBMIT_RETRY_CAP_MS);
          await this.sleep(delay);
          continue;
        }
        throw withLegacyOrphanHint(mapLegacyError(error, subject), resumeHint);
      }
    }
  }

  /** POST /v1/m2v/task/submit (URL-to-video with productLink, materials-to-video with fileIds). */
  submitM2v(body: Json): Promise<LegacySubmitted> {
    return this.submit("/v1/m2v/task/submit", body, "URL/materials-to-video");
  }

  /** POST /v1/m2v/export: render a script as the final HD video (billed on completion). */
  exportM2v(taskId: string, scriptId: number): Promise<LegacySubmitted> {
    const id = assertLegacyId(taskId);
    return this.submit("/v1/m2v/export", { taskId: id, scriptId }, `m2v export of task ${id}`);
  }

  submitVideoAvatar(body: Json): Promise<LegacySubmitted> {
    return this.submit("/v1/video_avatar/task/submit", body, "video avatar");
  }

  submitRemoveBackground(body: Json, resumeHint?: string): Promise<LegacySubmitted> {
    return this.submit(
      "/v1/common_task/remove_background/submit",
      body,
      "remove background",
      resumeHint,
    );
  }

  submitImageReplace(body: Json, resumeHint?: string): Promise<LegacySubmitted> {
    return this.submit(
      "/v3/product_avatar/task/image_replace/submit",
      body,
      "product avatar image replace",
      resumeHint,
    );
  }

  submitImage2Video(body: Json, resumeHint?: string): Promise<LegacySubmitted> {
    return this.submit(
      "/v3/product_avatar/task/image2Video/submit",
      body,
      "product avatar image to video",
      resumeHint,
    );
  }

  submitProductModel(body: Json): Promise<LegacySubmitted> {
    return this.submit(
      "/v3/product_anyShoot/product_model/task/submit",
      body,
      "product anyshoot try-on",
    );
  }

  submitProductBackground(body: Json): Promise<LegacySubmitted> {
    return this.submit(
      "/v3/product_anyShoot/product_background/task/submit",
      body,
      "product anyshoot background",
    );
  }

  async getTask(kind: LegacyTaskKind, taskId: string): Promise<LegacyTask> {
    const id = assertLegacyId(taskId);
    const subject = `${kind} task ${id}`;
    const result = await this.read(LEGACY_TASK_KINDS[kind].queryPath, subject, { taskId: id });
    return parseLegacyTask(kind, result, id);
  }

  /**
   * Poll until the task is done (see isLegacyTaskDone) and return it; callers
   * decide success. Retries network/408/429/5xx and 5xxx business codes;
   * throws PollTimeoutError on deadline.
   */
  async waitForTask(
    kind: LegacyTaskKind,
    taskId: string,
    opts: LegacyWaitOptions,
  ): Promise<LegacyTask> {
    const id = assertLegacyId(taskId);
    const subject = `${kind} task ${id}`;
    const path = LEGACY_TASK_KINDS[kind].queryPath;
    const isDone = opts.isDone ?? isLegacyTaskDone;
    try {
      return await pollUntil<LegacyTask>({
        fetchStatus: async ({ remainingMs }) =>
          parseLegacyTask(
            kind,
            unwrapLegacy(
              await this.raw("GET", path, {
                query: { taskId: id },
                timeoutMs: Math.max(1, Math.ceil(Math.min(REQUEST_TIMEOUT_MS, remainingMs))),
              }),
              subject,
            ),
            id,
          ),
        isTerminal: isDone,
        isTransientError: (e) =>
          isTransientHttpError(e) || (e instanceof TopviewApiError && e.isLegacyServerError),
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
      throw mapLegacyError(error, subject);
    }
  }

  /**
   * Upload one file and return its fileId. The presigned URL comes from the
   * API, so it is checked (https, public host) before any bytes are sent, and
   * the PUT carries no TopView headers. Uploads are not billed.
   */
  async uploadFile(opts: LegacyUploadOptions): Promise<string> {
    const subject = `upload of ${opts.filename}`;
    const format = opts.format.toLowerCase().replace(/^\./, "");
    const ticket = asRecord(await this.read("/v1/upload/credential", subject, { format }));
    if (!ticket || !isValidLegacyId(ticket.fileId) || typeof ticket.uploadUrl !== "string") {
      throw malformed(`upload credential without fileId or uploadUrl for ${opts.filename}`);
    }
    const fileId = ticket.fileId;
    const uploadUrl = ticket.uploadUrl;
    checkUrlSafety(uploadUrl, { provider: PROVIDER, action: "upload to" });

    const timeoutMs =
      REQUEST_TIMEOUT_MS + Math.ceil((opts.data.size / this.minUploadBytesPerSec) * 1000);
    let response: Response;
    try {
      response = await this.doFetch(uploadUrl, {
        method: "PUT",
        body: opts.data,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw mapLegacyError(toFetchError(cause, uploadUrl, { provider: PROVIDER }), subject);
    }
    if (!response.ok) {
      throw mapLegacyError(await httpErrorFromResponse(response, uploadUrl), subject);
    }
    await response.body?.cancel().catch(() => {});

    const checked = await this.read("/v1/upload/check", subject, { fileId });
    if (checked !== true && checked !== "true") {
      throw new ProviderError(
        `TopView did not confirm the ${subject} (upload check returned ${JSON.stringify(checked)}); upload it again`,
        PROVIDER,
      );
    }
    return fileId;
  }

  /**
   * GET /user/credit/detail: remaining plan credits (a balance, never spend)
   * and recent API tasks. API keys in the response are never returned.
   */
  async creditDetail(): Promise<LegacyCreditDetail> {
    const r = asRecord(await this.read("/user/credit/detail", "credit detail"));
    if (!r) throw malformed("credit detail without a result");
    const recentTasks: LegacyCreditDetail["recentTasks"] = [];
    const map = asRecord(r.apiKeyMap);
    // apiKeyMap is keyed by API key: read the values only, never the keys.
    for (const entries of map ? Object.values(map) : []) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const e = asRecord(entry);
        if (!e || recentTasks.length >= RECENT_TASKS_MAX) continue;
        const cost = parseCredit(e.costCredit);
        recentTasks.push({
          ...(isValidLegacyId(e.taskId) ? { taskId: e.taskId } : {}),
          ...(str(e.taskType) ? { taskType: (e.taskType as string).slice(0, 64) } : {}),
          ...(cost !== undefined ? { costCredit: cost } : {}),
          ...(str(e.date) ? { date: (e.date as string).slice(0, 40) } : {}),
        });
      }
    }
    const remain = parseCredit(r.remainCredit);
    return {
      ...(remain !== undefined ? { remainCredit: remain } : {}),
      ...(str(r.expiredTime) ? { expiredTime: (r.expiredTime as string).slice(0, 40) } : {}),
      recentTasks,
    };
  }
}
