/**
 * Cloudflare AI Gateway -> Replicate video predictions.
 *
 * Runtime-neutral: no node:* imports and no env access. Callers pass the
 * resolved config and an optional fetch, so the CLI and the MCP Worker share
 * the same request/response handling.
 */

import { ProviderError } from "../../core/errors.js";
import type { FetchLike } from "../../core/fetch-json.js";
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
}

export function cloudflareProviderFailure(status: number): ProviderError {
  return new ProviderError(`Cloudflare request failed with HTTP ${status}`, "Cloudflare");
}

export async function readCloudflareJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw cloudflareProviderFailure(response.status);
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

function send(opts: CloudflareVideoRequestOptions, url: string, init: RequestInit) {
  // Call without a receiver: Workers' native fetch rejects foreign `this`.
  const f = opts.fetch;
  return f ? f(url, init) : globalThis.fetch(url, init);
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
