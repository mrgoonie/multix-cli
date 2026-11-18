/**
 * ToAPIs client: async image and video generation, task polling, uploads,
 * the model list and the public price quote.
 *
 * Runtime-neutral: no node:* imports and no env/logger/fs access, so the same
 * client runs in the CLI and in a Cloudflare Worker.
 *
 * API contract (https://docs.toapis.com, verified live 2026-11-18):
 * - Auth: `Authorization: Bearer <TOAPIS_API_KEY>` on https://toapis.com
 * - Submit: POST /v1/{images|videos}/generations -> { id, status }
 * - Poll:   GET  /v1/{images|videos}/generations/{id}
 *           -> { status: queued|in_progress|completed|failed, result.data[].url,
 *                usage, billing: { status, credits, cost_usd } }
 * - Upload: POST /v1/uploads/{images|videos|audios} (multipart `file`) -> { data: { url } }
 * - Models: GET /v1/models?type=image|video|audio|all
 * - Quote:  POST /api/sku/quote/batch (public, undocumented; drives the pricing page)
 * Balance lives on a separate account API that rejects `sk-` keys, so it is not offered.
 */

import { PollTimeoutError, isTransientHttpError, pollUntil } from "../../core/async-poll.js";
import {
  ConfigError,
  HttpError,
  ProviderError,
  ProviderJobFailedError,
  ValidationError,
} from "../../core/errors.js";
import { toFetchError } from "../../core/fetch-error.js";
import {
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  fetchJson,
  httpErrorFromResponse,
} from "../../core/fetch-json.js";
import { fetchSameOrigin } from "../../core/redirect-fetch.js";
import { DEFAULT_TOAPIS_BASE_URL, TOAPIS_PROVIDER, TOAPIS_QUOTE_PATH } from "./models.js";
import type {
  ToapisClientOptions,
  ToapisMediaKind,
  ToapisModel,
  ToapisQuote,
  ToapisTask,
  ToapisUpload,
  ToapisUploadKind,
  WaitOptions,
} from "./types.js";

export { PollTimeoutError, TOAPIS_PROVIDER };

const TASK_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const DEFAULT_UPLOAD_TIMEOUT_MS = 300_000;
const QUOTE_TIMEOUT_MS = 15_000;

export function isTerminalStatus(status: unknown): boolean {
  return status === "completed" || status === "failed";
}

export function assertValidTaskId(id: string): void {
  if (!TASK_ID_RE.test(id)) throw new ValidationError(`Invalid ToAPIs task id: "${id}"`);
}

function errorText(task: ToapisTask): string {
  const e = task.error;
  if (!e) return `status "${task.status}"`;
  const parts = [e.reason, e.code, e.message].filter(
    (v) => v !== undefined && v !== null && v !== "",
  );
  return parts.length > 0 ? parts.join(": ") : `status "${task.status}"`;
}

/** A task ToAPIs failed (its quota hold is refunded per the billing policy). */
export class ToapisTaskFailedError extends ProviderJobFailedError {
  constructor(public readonly task: ToapisTask) {
    super(`ToAPIs task ${task.id} failed: ${errorText(task)}`, TOAPIS_PROVIDER);
    this.name = "ToapisTaskFailedError";
  }
}

/** Output URLs of a completed task, primary URL first. */
export function taskOutputUrls(task: ToapisTask): string[] {
  return (task.result?.data ?? [])
    .map((d) => d.url || d.fallback_url)
    .filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u));
}

/** USD actually charged, or undefined until ToAPIs settles the task. */
export function settledCostUsd(task: ToapisTask): number | undefined {
  if (task.billing?.status !== "settled" && task.billing?.status !== "refunded") return undefined;
  const n = Number(task.billing.cost_usd);
  return Number.isFinite(n) ? n : undefined;
}

export class ToapisClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;

  constructor(opts: ToapisClientOptions) {
    if (!opts.apiKey?.trim()) {
      throw new ConfigError(
        "TOAPIS_API_KEY is not set. Create one at https://toapis.com/dashboard/tokens",
      );
    }
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl?.trim() || DEFAULT_TOAPIS_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.uploadTimeoutMs = opts.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  }

  private doFetch(input: string, init?: RequestInit): Promise<Response> {
    // Workers' native fetch throws "Illegal invocation" when called as a method.
    const f = this.fetchImpl;
    return f ? f(input, init) : globalThis.fetch(input, init);
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
  }

  /** Submit a generation task; `body` holds `model`, `prompt` and the model's own fields. */
  async submit(kind: ToapisMediaKind, body: Record<string, unknown>): Promise<ToapisTask> {
    if (typeof body.model !== "string" || !body.model.trim()) {
      throw new ValidationError("ToAPIs request body needs a non-empty `model`");
    }
    const task = await fetchJson<ToapisTask & { task_id?: string }>({
      url: `${this.baseUrl}/v1/${kind}s/generations`,
      method: "POST",
      headers: this.authHeaders(),
      body,
      timeoutMs: this.timeoutMs,
      fetch: this.fetchImpl,
    });
    const id = task?.id || task?.task_id;
    if (typeof id !== "string" || !id) {
      throw new ProviderError("ToAPIs submit returned no task id", TOAPIS_PROVIDER);
    }
    // The id names local output files and later URLs; refuse anything unusual.
    assertValidTaskId(id);
    return { ...task, id, status: task.status || "queued" };
  }

  /** Fetch a task once (also accepts a `client_business_id`). */
  async getTask(kind: ToapisMediaKind, id: string, timeoutMs?: number): Promise<ToapisTask> {
    assertValidTaskId(id);
    const task = await fetchJson<ToapisTask>({
      url: `${this.baseUrl}/v1/${kind}s/generations/${encodeURIComponent(id)}`,
      headers: this.authHeaders(),
      timeoutMs: timeoutMs ?? this.timeoutMs,
      fetch: this.fetchImpl,
    });
    if (!task || typeof task !== "object") {
      throw new ProviderError(`ToAPIs task ${id}: empty response`, TOAPIS_PROVIDER);
    }
    const taskId = task.id || id;
    assertValidTaskId(taskId);
    return { ...task, id: taskId };
  }

  /** Poll until completed or failed. Throws PollTimeoutError at the deadline. */
  async waitForTask(
    kind: ToapisMediaKind,
    id: string,
    opts: WaitOptions = {},
  ): Promise<ToapisTask> {
    assertValidTaskId(id);
    return pollUntil<ToapisTask>({
      fetchStatus: ({ remainingMs }) =>
        this.getTask(kind, id, Math.ceil(Math.max(1000, Math.min(this.timeoutMs, remainingMs)))),
      isTerminal: (t) => isTerminalStatus(t.status),
      timeoutMs: opts.timeoutMs ?? (kind === "video" ? 900_000 : 300_000),
      // ToAPIs suggests 5 s then 10 s; backoff reaches that ceiling quickly.
      intervalMs: opts.intervalMs ?? 5000,
      maxIntervalMs: 10_000,
      isTransientError: isTransientHttpError,
      onPoll: opts.onPoll ? (t) => opts.onPoll?.(t) : undefined,
      resumeHint: opts.resumeHint,
    });
  }

  /** Upload a file and return its public URL (generation accepts URLs only, not base64). */
  async upload(
    kind: ToapisUploadKind,
    file: Blob | ArrayBuffer | Uint8Array,
    filename: string,
    mimeType?: string,
  ): Promise<ToapisUpload> {
    if (!filename.trim()) throw new ValidationError("upload needs a filename");
    const blob =
      file instanceof Blob
        ? file
        : new Blob([file as ArrayBuffer], { type: mimeType ?? "application/octet-stream" });
    const form = new FormData();
    form.append("file", blob, filename);
    form.append("purpose", "generation");

    const url = `${this.baseUrl}/v1/uploads/${kind}`;
    let response: Response;
    try {
      response = await fetchSameOrigin(
        url,
        {
          method: "POST",
          headers: this.authHeaders(),
          body: form,
          signal: AbortSignal.timeout(this.uploadTimeoutMs),
        },
        (input, init) => this.doFetch(input, init),
      );
    } catch (cause) {
      if (cause instanceof HttpError) throw cause;
      throw toFetchError(cause, url, { provider: TOAPIS_PROVIDER });
    }
    if (!response.ok) throw await httpErrorFromResponse(response, url);
    const json = (await response.json()) as {
      success?: boolean;
      message?: string;
      data?: Partial<ToapisUpload>;
    };
    const fileUrl = json.data?.url;
    if (json.success === false || typeof fileUrl !== "string" || !/^https?:\/\//i.test(fileUrl)) {
      throw new ProviderError(
        `ToAPIs upload returned no URL: ${json.message || "no message"}`,
        TOAPIS_PROVIDER,
      );
    }
    return { ...json.data, url: fileUrl };
  }

  /** Models available to this key; `type` defaults to all media types. */
  async listModels(type: "image" | "video" | "audio" | "all" = "all"): Promise<ToapisModel[]> {
    const json = await fetchJson<{ data?: ToapisModel[] }>({
      url: `${this.baseUrl}/v1/models?type=${type}`,
      headers: this.authHeaders(),
      timeoutMs: this.timeoutMs,
      fetch: this.fetchImpl,
    });
    return Array.isArray(json?.data) ? json.data : [];
  }
}

export interface QuoteItem {
  model: string;
  params: Record<string, unknown>;
}

/**
 * Price quotes from the public endpoint behind https://toapis.com/pricing.
 * Needs no key. Returns null for an item ToAPIs cannot price (unknown model or
 * unsupported option). For per_second models `estimated_price` is the unit
 * price times `params.duration`; per_request is not multiplied by `n`.
 */
export async function quoteToapis(
  items: readonly QuoteItem[],
  opts: { baseUrl?: string; fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<Array<ToapisQuote | null>> {
  if (items.length === 0) return [];
  const base = (opts.baseUrl?.trim() || DEFAULT_TOAPIS_BASE_URL).replace(/\/+$/, "");
  const json = await fetchJson<{
    data?: Array<{ key?: string; success?: boolean; data?: ToapisQuote }>;
  }>({
    url: `${base}${TOAPIS_QUOTE_PATH}`,
    method: "POST",
    headers: { Accept: "application/json" },
    body: { items: items.map((it, i) => ({ key: String(i), model: it.model, params: it.params })) },
    timeoutMs: opts.timeoutMs ?? QUOTE_TIMEOUT_MS,
    fetch: opts.fetch,
  });
  const rows = Array.isArray(json?.data) ? json.data : [];
  return items.map((_, i) => {
    const row = rows.find((r) => r.key === String(i));
    return row?.success && row.data ? row.data : null;
  });
}

/**
 * Estimated USD for one request from a quote: per_token video uses ToAPIs'
 * own per-second estimate times the duration; per_request is multiplied by
 * the image count. Undefined when the quote cannot price it.
 */
export function quoteEstimateUsd(
  quote: ToapisQuote | null,
  opts: { duration?: number; count?: number },
): number | undefined {
  if (!quote) return undefined;
  if (quote.charge_type === "per_token") {
    const perSecond = quote.estimated_second_price?.output_unit_price;
    return perSecond !== undefined && opts.duration ? perSecond * opts.duration : undefined;
  }
  if (quote.charge_type === "per_request") return quote.estimated_price * (opts.count ?? 1);
  return quote.estimated_price;
}
