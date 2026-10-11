/**
 * Cloudflare AI Gateway -> Replicate video predictions.
 *
 * Runtime-neutral: no node:* imports and no env access. Callers pass the
 * resolved config and an optional fetch, so the CLI and the MCP Worker share
 * the same request/response handling.
 */

import { HttpError, MultixError, ProviderError } from "../../core/errors.js";
import { DEFAULT_TIMEOUT_MS, type FetchLike } from "../../core/fetch-json.js";
import { fetchSameOrigin } from "../../core/redirect-fetch.js";
import { CLOUDFLARE_VIDEO_MODEL } from "./model-ids.js";

export interface CloudflareVideoConfig {
  accountId: string;
  apiToken: string;
  gatewayId: string;
  replicateApiToken: string;
}

export interface CloudflareVideoPrediction {
  id: string;
  status: string;
  output?: string | string[];
}

export interface CloudflareVideoRequestOptions {
  /** Defaults to globalThis.fetch at call time. */
  fetch?: FetchLike;
  /** Value of the `cf-aig-collect-log-payload` header. Default false. */
  collectLogPayload?: boolean;
  /** Send `Prefer: wait` on create. */
  wait?: boolean;
  /** Per-request timeout. Default 120s. */
  timeoutMs?: number;
}

export function cloudflareProviderFailure(status: number): ProviderError {
  return new ProviderError(`Cloudflare request failed with HTTP ${status}`, "Cloudflare");
}

/** Cancel the unread body (e.g. an unfollowed redirect) and build the failure. */
export async function cloudflareResponseFailure(response: Response): Promise<ProviderError> {
  await response.body?.cancel().catch(() => {});
  return cloudflareProviderFailure(response.status);
}

export async function readCloudflareJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw await cloudflareResponseFailure(response);
  try {
    return (await response.json()) as T;
  } catch {
    throw new ProviderError("Cloudflare returned an invalid JSON response", "Cloudflare");
  }
}

function videoUrl(config: CloudflareVideoConfig, suffix = ""): string {
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(config.accountId)}/${encodeURIComponent(config.gatewayId)}/replicate/predictions${suffix}`;
}

function videoHeaders(
  config: CloudflareVideoConfig,
  opts: CloudflareVideoRequestOptions,
): Record<string, string> {
  return {
    Authorization: `Bearer ${config.replicateApiToken}`,
    "cf-aig-authorization": `Bearer ${config.apiToken}`,
    "cf-aig-collect-log-payload": opts.collectLogPayload ? "true" : "false",
    "Content-Type": "application/json",
    ...(opts.wait ? { Prefer: "wait" } : {}),
  };
}

function isAbort(cause: unknown): boolean {
  const name = (cause as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Turn a fetch rejection into a multix error. Timeouts and network failures
 * become HttpError(0) naming only the gateway origin (the path holds the
 * account and gateway ids); anything else unexpected becomes a ProviderError.
 */
function cloudflareFetchFailure(cause: unknown, url: string, timeoutMs: number): MultixError {
  if (cause instanceof MultixError) return cause;
  const origin = new URL(url).origin;
  if (isAbort(cause)) {
    return new HttpError(0, `request timed out after ${timeoutMs / 1000}s`, origin, undefined, {
      cause,
    });
  }
  const msg = cause instanceof Error ? cause.message : String(cause);
  if (cause instanceof TypeError) {
    return new HttpError(0, `network error: ${msg}`, origin, undefined, { cause });
  }
  return new ProviderError(`Cloudflare request failed: ${msg}`, "Cloudflare", { cause });
}

async function send(
  opts: CloudflareVideoRequestOptions,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const withTimeout = { ...init, signal: AbortSignal.timeout(timeoutMs) };
  try {
    // The headers carry both tokens, so a redirect to another origin is not
    // followed. The injected fetch is called without a receiver (Workers'
    // native fetch rejects a foreign `this`).
    return await fetchSameOrigin(url, withTimeout, opts.fetch);
  } catch (cause) {
    throw cloudflareFetchFailure(cause, url, timeoutMs);
  }
}

/** Reject responses that are not prediction-shaped before they reach logs or callers. */
export function parseCloudflareVideoPrediction(value: unknown): CloudflareVideoPrediction {
  if (!value || typeof value !== "object") {
    throw new ProviderError("Cloudflare returned an invalid video prediction", "Cloudflare");
  }
  const result = value as Partial<CloudflareVideoPrediction>;
  if (typeof result.id !== "string" || typeof result.status !== "string") {
    throw new ProviderError("Cloudflare returned an invalid video prediction", "Cloudflare");
  }
  // Replicate reports `output: null` until a prediction finishes.
  const output = result.output === null ? undefined : result.output;
  if (
    output !== undefined &&
    typeof output !== "string" &&
    (!Array.isArray(output) || !output.every((item) => typeof item === "string"))
  ) {
    throw new ProviderError("Cloudflare returned an invalid video output", "Cloudflare");
  }
  return { id: result.id, status: result.status, output };
}

export async function createCloudflareVideoPrediction(
  config: CloudflareVideoConfig,
  input: Record<string, unknown>,
  opts: CloudflareVideoRequestOptions = {},
): Promise<CloudflareVideoPrediction> {
  const response = await send(opts, videoUrl(config), {
    method: "POST",
    headers: videoHeaders(config, opts),
    body: JSON.stringify({ version: CLOUDFLARE_VIDEO_MODEL, input }),
  });
  return parseCloudflareVideoPrediction(await readCloudflareJson<unknown>(response));
}

export async function getCloudflareVideoPrediction(
  config: CloudflareVideoConfig,
  id: string,
  opts: CloudflareVideoRequestOptions = {},
): Promise<CloudflareVideoPrediction> {
  const response = await send(opts, videoUrl(config, `/${encodeURIComponent(id)}`), {
    headers: videoHeaders(config, { ...opts, wait: false }),
  });
  return parseCloudflareVideoPrediction(await readCloudflareJson<unknown>(response));
}
