/**
 * Atlas Cloud media API client (image / video / audio / 3D predictions, uploads).
 *
 * Runtime-neutral: no node:* imports and no env/logger/fs access, so the same
 * client runs in the CLI and in a Cloudflare Worker. Callers pass the API key,
 * an optional base URL and an optional fetch implementation.
 *
 * API contract (https://www.atlascloud.ai/docs/predictions, /docs/upload-files):
 * - Auth: `Authorization: Bearer <ATLASCLOUD_API_KEY>`
 * - Base: https://api.atlascloud.ai/api/v1 (the LLM base /v1 is a different API)
 * - Submit: POST /model/generate{Image,Video,Audio} -> { code, data: { id, status } }
 * - Poll:   GET  /model/prediction/{id} -> { code, data: { status, outputs, error } }
 * - Upload: POST /model/uploadMedia (multipart `file`) -> { data: { download_url } }
 * - Catalog: GET /models (public) -> { data: [{ model, type, schema, ... }] }
 * Atlas documents no cancel endpoint, so none is offered.
 */

import { PollTimeoutError, isTransientHttpError, pollUntil } from "../../core/async-poll.js";
import { ConfigError, HttpError, ProviderError, ValidationError } from "../../core/errors.js";
import { toFetchError } from "../../core/fetch-error.js";
import {
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  fetchJson,
  httpErrorFromResponse,
} from "../../core/fetch-json.js";
import { fetchSameOrigin } from "../../core/redirect-fetch.js";
import { parseModelSpec } from "./model-input.js";
import { ATLAS_PROVIDER, DEFAULT_ATLAS_BASE_URL, SUBMIT_PATHS } from "./models.js";
import {
  isFailureStatus,
  isSuccessStatus,
  isTerminalStatus,
  predictionErrorMessage,
} from "./prediction-output.js";
import type {
  AtlasCatalogModel,
  AtlasClientOptions,
  AtlasEnvelope,
  AtlasMediaKind,
  AtlasModelSpec,
  AtlasPrediction,
  AtlasUploadResult,
  WaitOptions,
} from "./types.js";

export { ATLAS_PROVIDER };
const DEFAULT_UPLOAD_TIMEOUT_MS = 300_000;
const CATALOG_TIMEOUT_MS = 15_000;
const PREDICTION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** A prediction reached a terminal failure state; carries the provider payload. */
export class AtlasPredictionFailedError extends ProviderError {
  constructor(public readonly prediction: AtlasPrediction) {
    const reason = predictionErrorMessage(prediction.error) || `status "${prediction.status}"`;
    super(`Atlas Cloud prediction ${prediction.id} failed: ${reason}`, ATLAS_PROVIDER);
    this.name = "AtlasPredictionFailedError";
  }
}

export function assertValidPredictionId(id: string): void {
  if (!PREDICTION_ID_RE.test(id)) {
    throw new ValidationError(`Invalid Atlas Cloud prediction id: "${id}"`);
  }
}

/** Throw unless the prediction completed successfully. */
export function assertPredictionSucceeded(prediction: AtlasPrediction): void {
  if (isFailureStatus(prediction.status)) throw new AtlasPredictionFailedError(prediction);
  if (!isSuccessStatus(prediction.status)) {
    throw new ProviderError(
      `Atlas Cloud prediction ${prediction.id} is not finished (status "${prediction.status}")`,
      ATLAS_PROVIDER,
    );
  }
}

/**
 * Atlas reports a failed task as HTTP 5xx with the verdict in the body
 * (`{ code: 500, data: { status: "failed", error } }`). Recover that terminal
 * state so polling stops instead of retrying a decision already made.
 *
 * Only 5xx responses carrying the prediction envelope (`data.status`) qualify:
 * a 429/401 or a gateway error body must stay an HTTP error so it is retried
 * or reported as such, never mistaken for a finished job.
 */
export function terminalPredictionFromError(error: unknown, id: string): AtlasPrediction | null {
  if (!(error instanceof HttpError) || error.status < 500) return null;
  const snippet = error.snippet;
  try {
    const parsed = JSON.parse(snippet) as AtlasEnvelope<AtlasPrediction>;
    const data = parsed?.data;
    if (data && typeof data === "object" && isTerminalStatus(data.status)) {
      return { ...data, id: data.id || id };
    }
    return null;
  } catch {
    // The snippet is truncated at 500 chars; fall back to field extraction.
  }
  const dataAt = snippet.search(/"data"\s*:\s*\{/);
  if (dataAt === -1) return null;
  const inData = snippet.slice(dataAt);
  const status = /"status"\s*:\s*"([^"]+)"/.exec(inData)?.[1];
  if (status?.toLowerCase() !== "failed") return null;
  const err = /"error"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(inData)?.[1];
  return { id, status, error: err ?? snippet };
}

function envelopeData<T>(env: AtlasEnvelope<T> | undefined, what: string): T {
  if (!env || typeof env !== "object") {
    throw new ProviderError(`Atlas Cloud ${what}: empty response`, ATLAS_PROVIDER);
  }
  if (env.code !== undefined && env.code !== 200 && env.code !== 0 && env.data === undefined) {
    throw new ProviderError(
      `Atlas Cloud ${what} failed (code ${env.code}): ${env.msg || env.message || "unknown error"}`,
      ATLAS_PROVIDER,
    );
  }
  if (env.data === undefined || env.data === null) {
    throw new ProviderError(`Atlas Cloud ${what}: response has no data`, ATLAS_PROVIDER);
  }
  return env.data;
}

export class AtlasCloudClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private catalog?: Promise<AtlasCatalogModel[]>;

  constructor(opts: AtlasClientOptions) {
    if (!opts.apiKey?.trim()) {
      throw new ConfigError(
        "ATLASCLOUD_API_KEY is not set. Get one at https://www.atlascloud.ai/console/api-keys",
      );
    }
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl?.trim() || DEFAULT_ATLAS_BASE_URL).replace(/\/+$/, "");
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

  /** Catalog and schema lookups are advisory; fail fast so a slow catalog cannot stall a command. */
  private catalogTimeoutMs(): number {
    return Math.min(this.timeoutMs, CATALOG_TIMEOUT_MS);
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
  }

  /** Submit a generation job. `body` holds `model` plus the model's own fields, flattened. */
  async submit(kind: AtlasMediaKind, body: Record<string, unknown>): Promise<AtlasPrediction> {
    const path = SUBMIT_PATHS[kind];
    if (!path) throw new ValidationError(`Unknown Atlas Cloud media type: ${String(kind)}`);
    if (typeof body.model !== "string" || !body.model.trim()) {
      throw new ValidationError("Atlas Cloud request body needs a non-empty `model`");
    }
    const env = await fetchJson<AtlasEnvelope<AtlasPrediction>>({
      url: `${this.baseUrl}${path}`,
      method: "POST",
      headers: this.authHeaders(),
      body,
      timeoutMs: this.timeoutMs,
      fetch: this.fetchImpl,
    });
    const data = envelopeData(env, "submit");
    if (typeof data.id !== "string" || !data.id) {
      throw new ProviderError("Atlas Cloud submit returned no prediction id", ATLAS_PROVIDER);
    }
    return data;
  }

  /** Fetch a prediction once. A failed task reported as HTTP 5xx is returned, not thrown. */
  async getPrediction(id: string, timeoutMs?: number): Promise<AtlasPrediction> {
    assertValidPredictionId(id);
    try {
      const env = await fetchJson<AtlasEnvelope<AtlasPrediction>>({
        url: `${this.baseUrl}/model/prediction/${id}`,
        headers: this.authHeaders(),
        timeoutMs: timeoutMs ?? this.timeoutMs,
        fetch: this.fetchImpl,
      });
      const data = envelopeData(env, "prediction");
      return { ...data, id: data.id || id };
    } catch (error) {
      const terminal = terminalPredictionFromError(error, id);
      if (terminal) return terminal;
      throw error;
    }
  }

  /**
   * Poll until the prediction is terminal (success or failure) or the deadline
   * passes. Network errors, 408, 429 (honouring Retry-After) and 5xx are retried.
   * Throws PollTimeoutError on timeout; returns the terminal prediction otherwise.
   */
  async waitForPrediction(id: string, opts: WaitOptions): Promise<AtlasPrediction> {
    assertValidPredictionId(id);
    return pollUntil<AtlasPrediction>({
      // Cap each request at the time left so one hung poll cannot overrun the deadline.
      fetchStatus: ({ remainingMs }) =>
        this.getPrediction(id, Math.ceil(Math.max(1000, Math.min(this.timeoutMs, remainingMs)))),
      isTerminal: (p) => isTerminalStatus(p.status),
      timeoutMs: opts.timeoutMs,
      intervalMs: opts.intervalMs ?? 3000,
      maxIntervalMs: opts.maxIntervalMs ?? 15_000,
      isTransientError: isTransientHttpError,
      onPoll: opts.onPoll,
      resumeHint: opts.resumeHint,
      sleep: opts.sleep,
      now: opts.now,
    });
  }

  /**
   * Upload bytes and return a temporary URL usable as model input.
   * The filename extension matters: Atlas and downstream models classify by it.
   */
  async uploadMedia(
    file: Blob | ArrayBuffer | Uint8Array,
    filename: string,
    mimeType?: string,
  ): Promise<AtlasUploadResult> {
    if (!filename.trim()) throw new ValidationError("uploadMedia needs a filename");
    const blob =
      file instanceof Blob
        ? file
        : new Blob([file], { type: mimeType ?? "application/octet-stream" });
    const form = new FormData();
    form.append("file", blob, filename);

    const url = `${this.baseUrl}/model/uploadMedia`;
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
      throw toFetchError(cause, url, { provider: "atlascloud" });
    }
    if (!response.ok) throw await httpErrorFromResponse(response, url);

    const json = (await response.json()) as AtlasEnvelope<Record<string, unknown>> &
      Record<string, unknown>;
    const data = (json.data ?? {}) as Record<string, unknown>;
    // The official MCP server reads data.download_url; the docs show a top-level url.
    const fileUrl = [data.download_url, data.url, json.url].find(
      (v): v is string => typeof v === "string" && /^https?:\/\//i.test(v),
    );
    if (!fileUrl) {
      throw new ProviderError(
        `Atlas Cloud upload returned no URL (code ${json.code ?? "?"}: ${json.msg ?? json.message ?? "no message"})`,
        ATLAS_PROVIDER,
      );
    }
    return {
      url: fileUrl,
      filename: typeof data.filename === "string" ? data.filename : undefined,
      size: typeof data.size === "number" ? data.size : undefined,
      type: typeof data.type === "string" ? data.type : undefined,
    };
  }

  /** Public model catalog, fetched once per client. */
  listModels(): Promise<AtlasCatalogModel[]> {
    this.catalog ??= fetchJson<AtlasEnvelope<AtlasCatalogModel[]>>({
      url: `${this.baseUrl}/models`,
      timeoutMs: this.catalogTimeoutMs(),
      fetch: this.fetchImpl,
    })
      .then((env) => {
        const data = envelopeData(env, "model catalog");
        if (!Array.isArray(data)) {
          throw new ProviderError("Atlas Cloud model catalog is not a list", ATLAS_PROVIDER);
        }
        return data.filter((m) => m && typeof m.model === "string");
      })
      .catch((error: unknown) => {
        this.catalog = undefined;
        throw error;
      });
    return this.catalog;
  }

  /** Exact (case-sensitive) catalog lookup; model ids are never rewritten. */
  async findModel(model: string): Promise<AtlasCatalogModel | undefined> {
    return (await this.listModels()).find((m) => m.model === model);
  }

  /**
   * Load the model's published request schema and submit endpoint.
   * Returns undefined when the model is not in the public catalog or publishes no schema.
   */
  async getModelSpec(model: string): Promise<AtlasModelSpec | undefined> {
    const entry = await this.findModel(model);
    if (!entry?.schema || !/^https:\/\//i.test(entry.schema)) return undefined;
    const doc = await fetchJson<unknown>({
      url: entry.schema,
      timeoutMs: this.catalogTimeoutMs(),
      fetch: this.fetchImpl,
    });
    return parseModelSpec(model, doc);
  }
}

export { PollTimeoutError };
