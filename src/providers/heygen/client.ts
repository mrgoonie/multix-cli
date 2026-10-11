/**
 * HeyGen v3 REST client. Runtime-neutral: no node:* imports, no env/fs/logger
 * access — callers pass `{ apiKey, baseUrl?, fetch? }` so the same client runs
 * in the CLI and in non-Node runtimes such as a Cloudflare Worker.
 *
 * Auth: `X-Api-Key` header. Responses use a `{ data }` / `{ error }` envelope;
 * list endpoints add `has_more` / `next_token` cursor fields.
 */

import { HttpError, ProviderError, ValidationError } from "../../core/errors.js";
import { type FetchLike, fetchJson, httpErrorFromResponse } from "../../core/fetch-json.js";
import { redactUrl } from "../../core/redact.js";
import { HeygenApiError, toHeygenApiError } from "./heygen-errors.js";
import { DEFAULT_HEYGEN_BASE_URL, LIMITS } from "./models.js";
import type {
  CreateAvatarVideoRequest,
  CreateLipsyncRequest,
  CreateLipsyncResponse,
  CreateModelVideoRequest,
  CreateModelVideoResponse,
  CreateSpeechRequest,
  CreateSpeechResponse,
  CreateVideoAgentRequest,
  CreateVideoAgentResponse,
  CreateVideoResponse,
  CreateVideoTranslationRequest,
  CreateVideoTranslationResponse,
  HeygenAvatarGroup,
  HeygenAvatarLook,
  HeygenLipsync,
  HeygenModelVideo,
  HeygenPage,
  HeygenUserInfo,
  HeygenVideoDetail,
  HeygenVideoTranslation,
  HeygenVoice,
  ListAvatarGroupsQuery,
  ListAvatarLooksQuery,
  ListVideoAgentStylesQuery,
  ListVoicesQuery,
  UploadAssetResponse,
  VideoAgentSession,
  VideoAgentStyle,
} from "./types.js";

export interface HeygenClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Per-request timeout. Default 120s. */
  timeoutMs?: number;
  /** Max attempts for a create request on 429/5xx (see `send`). Default 3. */
  maxAttempts?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Idempotency-key generator. Default `crypto.randomUUID()`. */
  newIdempotencyKey?: () => string;
}

export interface HeygenRequestOptions {
  method?: "GET" | "POST" | "DELETE" | "PATCH";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * Send an `Idempotency-Key` header (only for endpoints that document it).
   * `true` generates a UUID once for this call; a string is used verbatim.
   */
  idempotencyKey?: boolean | string;
  /** Per-request timeout, capped at the client's timeout. Polling passes the remaining wait. */
  timeoutMs?: number;
}

/** Per-call options for status getters. */
export interface HeygenCallOptions {
  timeoutMs?: number;
}

/** Upload input. Bytes or a Blob only — reading local files is the caller's job. */
export interface HeygenUploadInput {
  data: Blob | Uint8Array | ArrayBuffer;
  filename: string;
  mimeType: string;
}

const MAX_RETRY_WAIT_MS = 60_000;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `encodeURIComponent` for path segments. Rejects non-strings, empty IDs and
 * dot segments (URL normalisation would turn `/v3/videos/..` into `/v3/`).
 */
function seg(id: unknown, label: string): string {
  if (typeof id !== "string") throw new ValidationError(`${label} must be a string`);
  const trimmed = id.trim();
  if (!trimmed) throw new ValidationError(`${label} must not be empty`);
  if (trimmed === "." || trimmed === "..") {
    throw new ValidationError(`Invalid ${label}: "${trimmed}"`);
  }
  return encodeURIComponent(trimmed);
}

/** JSON of a response payload with URL query strings redacted, for error messages. */
function describePayload(data: unknown): string {
  const text = JSON.stringify(data, (_k, v) =>
    typeof v === "string" && /^https?:\/\//i.test(v) ? redactUrl(v) : v,
  );
  return (text ?? String(data)).slice(0, 500);
}

/**
 * Require the documented job ID in a create response. A 2xx without it means a
 * paid job may exist that cannot be tracked, so surface the raw payload.
 */
function requireJobId<T>(data: T, field: keyof T & string, path: string): T {
  const value = (data as Record<string, unknown> | null)?.[field];
  const ok = Array.isArray(value)
    ? value.length > 0 && value.every((v) => typeof v === "string" && v.length > 0)
    : typeof value === "string" && value.length > 0;
  if (!ok) {
    throw new ProviderError(
      `HeyGen ${path} returned no ${field}; a job may still have been created, so check the HeyGen dashboard. Response: ${describePayload(data)}`,
      "heygen",
    );
  }
  return data;
}

export class HeygenClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newIdempotencyKey: () => string;

  constructor(opts: HeygenClientOptions) {
    if (!opts.apiKey?.trim()) throw new ValidationError("HeyGen apiKey is required");
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl ?? DEFAULT_HEYGEN_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.sleep = opts.sleep ?? defaultSleep;
    this.newIdempotencyKey = opts.newIdempotencyKey ?? (() => crypto.randomUUID());
  }

  /** Build an absolute URL for a v3 path plus query parameters. */
  url(path: string, query?: HeygenRequestOptions["query"]): string {
    const suffix = path.startsWith("/") ? path : `/${path}`;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== "") params.set(k, String(v));
    }
    const qs = params.toString();
    return `${this.baseUrl}${suffix}${qs ? `?${qs}` : ""}`;
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    return {
      Accept: "application/json",
      "X-Api-Key": this.apiKey,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    };
  }

  /**
   * Send a request and return the raw parsed JSON (envelope included).
   * Retries are bounded and only where safe: a 429 carrying Retry-After was
   * rejected before processing; 5xx/network failures and 409
   * `request_in_progress` are retried only when an Idempotency-Key makes the
   * replay safe. GET requests are left to the caller's polling loop.
   */
  async send<T = unknown>(path: string, opts: HeygenRequestOptions = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const key =
      typeof opts.idempotencyKey === "string"
        ? opts.idempotencyKey
        : opts.idempotencyKey
          ? this.newIdempotencyKey()
          : undefined;
    const url = this.url(path, opts.query);

    for (let attempt = 1; ; attempt++) {
      try {
        return await fetchJson<T>({
          url,
          method,
          headers: this.headers(key),
          body: opts.body,
          timeoutMs: Math.max(1, Math.min(this.timeoutMs, opts.timeoutMs ?? this.timeoutMs)),
          fetch: this.fetchImpl,
        });
      } catch (error) {
        const apiError = error instanceof HttpError ? toHeygenApiError(error) : error;
        if (method === "GET" || attempt >= this.maxAttempts || !(apiError instanceof HttpError)) {
          throw apiError;
        }
        const wait = this.retryDelay(apiError, key, attempt);
        if (wait === undefined) throw apiError;
        await this.sleep(wait);
      }
    }
  }

  private retryDelay(
    error: HttpError,
    key: string | undefined,
    attempt: number,
  ): number | undefined {
    const code = error instanceof HeygenApiError ? error.apiCode : undefined;
    if (error.status === 429 && error.retryAfterMs !== undefined && code !== "quota_exceeded") {
      return Math.min(error.retryAfterMs, MAX_RETRY_WAIT_MS);
    }
    if (!key) return undefined;
    if (error.status === 0 || error.status >= 500 || code === "request_in_progress") {
      return Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_WAIT_MS);
    }
    return undefined;
  }

  /** Send and unwrap `{ data }`. A 2xx body carrying `error` is treated as a failure. */
  async request<T>(path: string, opts: HeygenRequestOptions = {}): Promise<T> {
    const json = await this.send<Record<string, unknown>>(path, opts);
    return unwrapData<T>(json, path);
  }

  private async page<T>(path: string, query: Record<string, unknown>): Promise<HeygenPage<T>> {
    const json = await this.send<Record<string, unknown>>(path, {
      query: query as HeygenRequestOptions["query"],
    });
    const items = unwrapData<T[]>(json, path);
    if (!Array.isArray(items)) {
      throw new ProviderError(
        `Unexpected HeyGen response from ${path}: data is not a list`,
        "heygen",
      );
    }
    const next = json.next_token;
    return {
      items,
      hasMore: json.has_more === true,
      nextToken: typeof next === "string" && next ? next : null,
    };
  }

  // ── Account ───────────────────────────────────────────────────────────

  getCurrentUser(): Promise<HeygenUserInfo> {
    return this.request("/v3/users/me");
  }

  // ── Video Agent ───────────────────────────────────────────────────────

  /** POST /v3/video-agents. No Idempotency-Key: the endpoint does not document one. */
  async createVideoAgent(body: CreateVideoAgentRequest): Promise<CreateVideoAgentResponse> {
    const path = "/v3/video-agents";
    const data = await this.request<CreateVideoAgentResponse>(path, { method: "POST", body });
    return requireJobId(data, "session_id", path);
  }

  async getVideoAgentSession(
    sessionId: string,
    opts: HeygenCallOptions = {},
  ): Promise<VideoAgentSession> {
    return this.request(`/v3/video-agents/${seg(sessionId, "session id")}`, opts);
  }

  listVideoAgentStyles(
    query: ListVideoAgentStylesQuery = {},
  ): Promise<HeygenPage<VideoAgentStyle>> {
    return this.page("/v3/video-agents/styles", { ...query });
  }

  // ── Videos ────────────────────────────────────────────────────────────

  async createVideo(
    body: CreateAvatarVideoRequest | Record<string, unknown>,
    idempotencyKey: boolean | string = true,
  ): Promise<CreateVideoResponse> {
    const path = "/v3/videos";
    const data = await this.request<CreateVideoResponse>(path, {
      method: "POST",
      body,
      idempotencyKey,
    });
    return requireJobId(data, "video_id", path);
  }

  async getVideo(videoId: string, opts: HeygenCallOptions = {}): Promise<HeygenVideoDetail> {
    return this.request(`/v3/videos/${seg(videoId, "video id")}`, opts);
  }

  /** POST /v3/templates/{id}. Returns the created video's `VideoDetail`. */
  async generateFromTemplate(
    templateId: string,
    body: Record<string, unknown>,
    idempotencyKey: boolean | string = true,
  ): Promise<HeygenVideoDetail> {
    const path = `/v3/templates/${seg(templateId, "template id")}`;
    const data = await this.request<HeygenVideoDetail>(path, {
      method: "POST",
      body,
      idempotencyKey,
    });
    return requireJobId(data, "id", path);
  }

  // ── HeyGen Video model ────────────────────────────────────────────────

  async createModelVideo(
    body: CreateModelVideoRequest,
    idempotencyKey: boolean | string = true,
  ): Promise<CreateModelVideoResponse> {
    const path = "/v3/models/videos";
    const data = await this.request<CreateModelVideoResponse>(path, {
      method: "POST",
      body,
      idempotencyKey,
    });
    return requireJobId(data, "video_id", path);
  }

  async getModelVideo(videoId: string, opts: HeygenCallOptions = {}): Promise<HeygenModelVideo> {
    return this.request(`/v3/models/videos/${seg(videoId, "video id")}`, opts);
  }

  // ── Catalog ───────────────────────────────────────────────────────────

  listAvatarGroups(query: ListAvatarGroupsQuery = {}): Promise<HeygenPage<HeygenAvatarGroup>> {
    return this.page("/v3/avatars", { ...query });
  }

  /** Looks are what video generation needs: a look `id` is the `avatar_id`. */
  listAvatarLooks(query: ListAvatarLooksQuery = {}): Promise<HeygenPage<HeygenAvatarLook>> {
    return this.page("/v3/avatars/looks", { ...query });
  }

  listVoices(query: ListVoicesQuery = {}): Promise<HeygenPage<HeygenVoice>> {
    return this.page("/v3/voices", { ...query });
  }

  // ── Speech ────────────────────────────────────────────────────────────

  createSpeech(body: CreateSpeechRequest): Promise<CreateSpeechResponse> {
    return this.request("/v3/voices/speech", { method: "POST", body });
  }

  // ── Translation & lipsync ─────────────────────────────────────────────

  async createVideoTranslation(
    body: CreateVideoTranslationRequest,
    idempotencyKey: boolean | string = true,
  ): Promise<CreateVideoTranslationResponse> {
    const path = "/v3/video-translations";
    const data = await this.request<CreateVideoTranslationResponse>(path, {
      method: "POST",
      body,
      idempotencyKey,
    });
    return requireJobId(data, "video_translation_ids", path);
  }

  async getVideoTranslation(
    id: string,
    opts: HeygenCallOptions = {},
  ): Promise<HeygenVideoTranslation> {
    return this.request(`/v3/video-translations/${seg(id, "video translation id")}`, opts);
  }

  async listTranslationLanguages(): Promise<string[]> {
    const data = await this.request<{ languages?: unknown }>("/v3/video-translations/languages");
    if (!Array.isArray(data.languages)) {
      throw new ProviderError("Unexpected HeyGen response: languages is not a list", "heygen");
    }
    return data.languages.filter((l): l is string => typeof l === "string");
  }

  async createLipsync(
    body: CreateLipsyncRequest,
    idempotencyKey: boolean | string = true,
  ): Promise<CreateLipsyncResponse> {
    const path = "/v3/lipsyncs";
    const data = await this.request<CreateLipsyncResponse>(path, {
      method: "POST",
      body,
      idempotencyKey,
    });
    return requireJobId(data, "lipsync_id", path);
  }

  async getLipsync(id: string, opts: HeygenCallOptions = {}): Promise<HeygenLipsync> {
    return this.request(`/v3/lipsyncs/${seg(id, "lipsync id")}`, opts);
  }

  // ── Assets ────────────────────────────────────────────────────────────

  /**
   * POST /v3/assets (multipart, max 32 MB). Accepts bytes or a Blob so it works
   * without a filesystem; for remote files prefer passing `{type:"url"}` inputs.
   */
  async uploadAsset(input: HeygenUploadInput): Promise<UploadAssetResponse> {
    const blob =
      input.data instanceof Blob ? input.data : new Blob([input.data], { type: input.mimeType });
    if (blob.size === 0) throw new ValidationError(`Cannot upload empty file ${input.filename}`);
    if (blob.size > LIMITS.assetUploadMaxBytes) {
      throw new ValidationError(
        `${input.filename} is ${(blob.size / 1024 / 1024).toFixed(1)} MB; POST /v3/assets accepts at most 32 MB. Host the file at a public HTTPS URL and pass the URL instead.`,
      );
    }
    const typed = blob.type ? blob : new Blob([blob], { type: input.mimeType });
    const key = this.newIdempotencyKey();
    const url = this.url("/v3/assets");
    const doFetch: FetchLike = this.fetchImpl ?? ((u, init) => globalThis.fetch(u, init));

    for (let attempt = 1; ; attempt++) {
      const form = new FormData();
      form.append("file", typed, input.filename);
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: this.headers(key),
          body: form,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        const err = toHeygenApiError(new HttpError(0, msg, url));
        if (attempt >= this.maxAttempts) throw err;
        await this.sleep(this.retryDelay(err, key, attempt) ?? 1000);
        continue;
      }
      if (response.ok) {
        let json: unknown;
        try {
          json = await response.json();
        } catch {
          throw new ProviderError(
            `HeyGen /v3/assets returned a non-JSON response (HTTP ${response.status}) for ${input.filename}`,
            "heygen",
          );
        }
        const data = unwrapData<UploadAssetResponse>(json, "/v3/assets");
        return requireJobId(data, "asset_id", "/v3/assets");
      }
      const err = toHeygenApiError(await httpErrorFromResponse(response, url));
      const wait = attempt < this.maxAttempts ? this.retryDelay(err, key, attempt) : undefined;
      if (wait === undefined) throw err;
      await this.sleep(wait);
    }
  }
}

/** Unwrap `{ data }`, rejecting `{ error }` bodies and missing payloads. */
export function unwrapData<T>(json: unknown, path: string): T {
  if (json === null || typeof json !== "object") {
    throw new ProviderError(`Unexpected HeyGen response from ${path}: not a JSON object`, "heygen");
  }
  const record = json as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object") {
    const e = error as { code?: string; message?: string };
    throw new ProviderError(
      `HeyGen API error${e.code ? ` (${e.code})` : ""}: ${e.message ?? "unknown error"}`,
      "heygen",
    );
  }
  if (!("data" in record) || record.data === null || record.data === undefined) {
    throw new ProviderError(`Unexpected HeyGen response from ${path}: missing data`, "heygen");
  }
  return record.data as T;
}
