/**
 * Direct Replicate HTTP API client (https://api.replicate.com/v1).
 *
 * Runtime-neutral: no node:* imports, no env/logger/disk access. Callers pass
 * `apiKey`, optional `baseUrl`, and optional `fetch`, so the same client runs
 * in the Node CLI and in non-Node runtimes such as a Cloudflare Worker.
 *
 * - Official models: POST /models/{owner}/{name}/predictions
 * - Explicit versions: POST /predictions with `version`
 * - `Prefer: wait=N` may still return a nonterminal prediction; callers must
 *   keep polling until a terminal status.
 */

import { PollTimeoutError, isTransientHttpError, pollUntil } from "../../core/async-poll.js";
import { HttpError, ProviderError, ProviderJobFailedError } from "../../core/errors.js";
import { toFetchError } from "../../core/fetch-error.js";
import { type FetchLike, fetchJson, httpErrorFromResponse } from "../../core/fetch-json.js";
import { fetchSameOrigin } from "../../core/redirect-fetch.js";
import {
  DEFAULT_REPLICATE_BASE_URL,
  assertPredictionId,
  isTerminalStatus,
  isValidPredictionId,
} from "./models.js";
import type { ModelRef, ReplicateFile, ReplicatePrediction } from "./types.js";

const PROVIDER = "replicate";
const DETAIL_MAX = 300;
const CREATE_MAX_RETRIES = 2;
const CREATE_RETRY_CAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 300_000;

/** Replicate API error with an actionable message; keeps status for programmatic use. */
export class ReplicateApiError extends ProviderError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, PROVIDER, options);
    this.name = "ReplicateApiError";
  }
}

/** A prediction reached failed/canceled/aborted — never a success. */
export class ReplicatePredictionError extends ProviderJobFailedError {
  constructor(public readonly prediction: ReplicatePrediction) {
    const detail = formatPredictionError(prediction.error);
    super(
      `Replicate prediction ${prediction.id} ${prediction.status}${detail ? `: ${detail}` : ""}`,
      PROVIDER,
    );
    this.name = "ReplicatePredictionError";
  }
}

function formatPredictionError(error: unknown): string {
  if (error === null || error === undefined || error === "") return "";
  const text = typeof error === "string" ? error : JSON.stringify(error);
  return text.slice(0, DETAIL_MAX);
}

/** Pull `detail`/`title` from a problem+json body, else the raw snippet. */
function errorDetail(snippet: string): string {
  try {
    const body = JSON.parse(snippet) as Record<string, unknown>;
    const detail = body.detail ?? body.title ?? body.error;
    if (typeof detail === "string" && detail) return detail.slice(0, DETAIL_MAX);
  } catch {
    // not JSON — fall through to the raw snippet
  }
  return snippet.trim().slice(0, DETAIL_MAX);
}

/**
 * Map an HTTP failure to an actionable message. `subject` names what was
 * requested (a model or a prediction) so 404s point at the right fix.
 */
export function mapReplicateError(error: unknown, subject: string): unknown {
  if (!(error instanceof HttpError)) return error;
  const detail = errorDetail(error.snippet);
  const suffix = detail ? `: ${detail}` : "";
  const { status, retryAfterMs } = error;
  let message: string;
  if (status === 0) {
    message = `Network error contacting Replicate${suffix}`;
  } else if (status === 401) {
    message =
      "Replicate rejected the API token (401). Check REPLICATE_API_TOKEN (or REPLICATE_API_KEY); create one at https://replicate.com/account/api-tokens";
  } else if (status === 402) {
    message = `Replicate requires billing for this request (402)${suffix}. See https://replicate.com/account/billing`;
  } else if (status === 403) {
    message = `Replicate denied access to ${subject} (403)${suffix}`;
  } else if (status === 404) {
    message = subject.startsWith("prediction")
      ? `Replicate could not find ${subject} (404); it may belong to another account or have expired`
      : `Replicate could not find ${subject} (404). Check owner/name; community models need an explicit version (owner/name:version or --version)`;
  } else if (status === 422) {
    message = `Replicate rejected the input for ${subject} (422)${suffix}. Check the model's input schema on replicate.com`;
  } else if (status === 429) {
    const wait =
      retryAfterMs !== undefined ? `; retry after ${Math.ceil(retryAfterMs / 1000)}s` : "";
    message = `Replicate rate limit reached (429)${wait}`;
  } else if (status >= 500) {
    message = `Replicate server error (${status})${suffix}. Try again later`;
  } else {
    message = `Replicate request for ${subject} failed (${status})${suffix}`;
  }
  return new ReplicateApiError(message, status, retryAfterMs, { cause: error });
}

export const ORPHAN_HINT =
  "The prediction may have been created anyway (Replicate has no idempotency key); check https://replicate.com/predictions before retrying to avoid paying twice";

/**
 * A network error, timeout, 5xx, or an unusable 2xx body (invalid JSON or not
 * a prediction) on create can happen after Replicate has already created (and
 * started billing) the prediction, leaving no id to resume or cancel. Point
 * the user at the dashboard before they retry.
 */
function withOrphanHint(error: unknown): unknown {
  if (error instanceof ReplicateApiError) {
    const { status } = error;
    const mayExist = status === 0 || (status >= 200 && status < 300) || status >= 500;
    if (!mayExist) return error;
    return new ReplicateApiError(`${error.message}. ${ORPHAN_HINT}`, status, error.retryAfterMs, {
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

/** Reject responses that are not prediction-shaped instead of trusting them. */
export function validatePrediction(value: unknown): ReplicatePrediction {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as ReplicatePrediction).id !== "string" ||
    typeof (value as ReplicatePrediction).status !== "string"
  ) {
    throw new ProviderError("Malformed Replicate response: missing prediction id/status", PROVIDER);
  }
  // Server-supplied ids flow into URL paths, file names, and printed commands.
  if (!isValidPredictionId((value as ReplicatePrediction).id)) {
    throw new ProviderError("Malformed Replicate response: invalid prediction id", PROVIDER);
  }
  return value as ReplicatePrediction;
}

/** Throw for failed/canceled/aborted; return the prediction when it succeeded. */
export function assertSucceeded(prediction: ReplicatePrediction): ReplicatePrediction {
  if (prediction.status === "succeeded") return prediction;
  if (isTerminalStatus(prediction.status)) throw new ReplicatePredictionError(prediction);
  throw new ProviderError(
    `Replicate prediction ${prediction.id} is not finished (status: ${prediction.status})`,
    PROVIDER,
  );
}

export interface ReplicateClientOptions {
  apiKey: string;
  /** Defaults to https://api.replicate.com/v1. */
  baseUrl?: string;
  /** Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Injectable for tests (429 retry back-off). */
  sleep?: (ms: number) => Promise<void>;
}

export interface CreatePredictionOptions {
  model: ModelRef;
  input: Record<string, unknown>;
  /** Send `Prefer: wait=N` (1–60 s). The response may still be nonterminal. */
  preferWaitSeconds?: number;
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  maxIntervalMs?: number;
  /** Appended to the timeout message, e.g. a resume command. */
  resumeHint?: string;
  onPoll?: (prediction: ReplicatePrediction, attempt: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface UploadFileOptions {
  data: Blob;
  filename: string;
  contentType: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ReplicateClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ReplicateClientOptions) {
    if (!opts.apiKey) throw new ProviderError("Replicate API token is required", PROVIDER);
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_REPLICATE_BASE_URL).replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { accept: "application/json", authorization: `Bearer ${this.apiKey}`, ...extra };
  }

  /** Raw request: throws HttpError so polling can classify transient failures. */
  private raw<T>(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    headers?: Record<string, string>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    return fetchJson<T>({
      url: `${this.baseUrl}${path}`,
      method,
      headers: this.headers(headers),
      body,
      timeoutMs,
      fetch: this.doFetch,
    });
  }

  /** Create a prediction on the official-model or versioned endpoint. */
  async createPrediction(opts: CreatePredictionOptions): Promise<ReplicatePrediction> {
    const { model, input } = opts;
    const isOfficial = model.kind === "official";
    const path = isOfficial ? `/models/${model.owner}/${model.name}/predictions` : "/predictions";
    const body = isOfficial ? { input } : { version: model.version, input };
    const subject = isOfficial
      ? `model ${model.owner}/${model.name}`
      : `model version ${model.version}`;

    const headers: Record<string, string> = {};
    let timeoutMs = REQUEST_TIMEOUT_MS;
    if (opts.preferWaitSeconds !== undefined) {
      const seconds = Math.min(60, Math.max(1, Math.round(opts.preferWaitSeconds)));
      headers.prefer = `wait=${seconds}`;
      timeoutMs += seconds * 1000;
    }

    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.raw<unknown>(path, "POST", body, headers, timeoutMs);
        return validatePrediction(res);
      } catch (error) {
        // A 429 on create means nothing was created, so retrying is safe.
        if (error instanceof HttpError && error.status === 429 && attempt < CREATE_MAX_RETRIES) {
          const delay = Math.min(error.retryAfterMs ?? 2000 * (attempt + 1), CREATE_RETRY_CAP_MS);
          await this.sleep(delay);
          continue;
        }
        throw withOrphanHint(mapReplicateError(error, subject));
      }
    }
  }

  async getPrediction(id: string): Promise<ReplicatePrediction> {
    const safeId = assertPredictionId(id);
    try {
      return validatePrediction(await this.raw<unknown>(`/predictions/${safeId}`, "GET"));
    } catch (error) {
      throw mapReplicateError(error, `prediction ${safeId}`);
    }
  }

  /** Cancel a running prediction (POST /predictions/{id}/cancel). */
  async cancelPrediction(id: string): Promise<ReplicatePrediction> {
    const safeId = assertPredictionId(id);
    try {
      return validatePrediction(await this.raw<unknown>(`/predictions/${safeId}/cancel`, "POST"));
    } catch (error) {
      throw mapReplicateError(error, `prediction ${safeId}`);
    }
  }

  /**
   * Poll until the prediction reaches a terminal status (succeeded, failed,
   * canceled, aborted) and return it — callers decide success via
   * assertSucceeded. Retries network/408/429/5xx; throws PollTimeoutError on deadline.
   */
  async waitForPrediction(
    prediction: ReplicatePrediction | string,
    opts: WaitOptions,
  ): Promise<ReplicatePrediction> {
    if (typeof prediction !== "string" && isTerminalStatus(prediction.status)) return prediction;
    const safeId = assertPredictionId(typeof prediction === "string" ? prediction : prediction.id);
    try {
      return await pollUntil<ReplicatePrediction>({
        fetchStatus: async ({ remainingMs }) =>
          validatePrediction(
            await this.raw<unknown>(
              `/predictions/${safeId}`,
              "GET",
              undefined,
              undefined,
              // AbortSignal.timeout needs a positive integer; clocks may be fractional.
              Math.max(1, Math.ceil(Math.min(REQUEST_TIMEOUT_MS, remainingMs))),
            ),
          ),
        isTerminal: (p) => isTerminalStatus(p.status),
        isTransientError: isTransientHttpError,
        timeoutMs: opts.timeoutMs,
        intervalMs: opts.intervalMs ?? 2000,
        maxIntervalMs: opts.maxIntervalMs ?? 10_000,
        resumeHint: opts.resumeHint,
        onPoll: opts.onPoll,
        sleep: opts.sleep ?? this.sleep,
        now: opts.now,
      });
    } catch (error) {
      if (error instanceof PollTimeoutError) throw error;
      throw mapReplicateError(error, `prediction ${safeId}`);
    }
  }

  /**
   * Upload a file via the Files API (multipart, < 100 MB) and return the file
   * resource; pass `urls.get` as a model input value.
   */
  async uploadFile(opts: UploadFileOptions): Promise<ReplicateFile> {
    const form = new FormData();
    const blob = opts.data.type ? opts.data : new Blob([opts.data], { type: opts.contentType });
    form.append("content", blob, opts.filename);
    form.append("filename", opts.filename);
    form.append("type", opts.contentType);

    const url = `${this.baseUrl}/files`;
    const subject = `file upload ${opts.filename}`;
    let response: Response;
    try {
      response = await fetchSameOrigin(
        url,
        {
          method: "POST",
          headers: this.headers(),
          body: form,
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        },
        this.doFetch,
      );
    } catch (cause) {
      if (cause instanceof HttpError) throw mapReplicateError(cause, subject);
      throw mapReplicateError(toFetchError(cause, url, { provider: PROVIDER }), subject);
    }
    if (!response.ok) {
      if (response.status === 413) {
        throw new ReplicateApiError(
          "Replicate rejected the upload: files must be less than 100MB",
          413,
        );
      }
      throw mapReplicateError(await httpErrorFromResponse(response, url), subject);
    }
    const file = (await response.json()) as ReplicateFile;
    if (typeof file?.urls?.get !== "string") {
      throw new ProviderError("Malformed Replicate file response: missing urls.get", PROVIDER);
    }
    return file;
  }
}
