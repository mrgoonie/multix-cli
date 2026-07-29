import { resolveKey } from "../../core/env-loader.js";
import { ProviderError } from "../../core/errors.js";
import {
  CLOUDFLARE_VIDEO_MODEL,
  type CloudflareConfig,
  type CloudflareVideoConfig,
  requireCloudflareConfig,
  requireCloudflareVideoConfig,
} from "./models.js";

interface CloudflareResponse<T> {
  result?: T;
  success?: boolean;
}

export interface CloudflareVideoPrediction {
  id: string;
  status: string;
  output?: string | string[];
}

function collectPayloadHeader(): string {
  const envName = ["CLOUDFLARE", "AI", "GATEWAY", "COLLECT", "LOG", "PAYLOAD"].join("_");
  return resolveKey(envName) === "true" ? "true" : "false";
}

function gatewayHeaders(config: CloudflareConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiToken}`,
    "Content-Type": "application/json",
    "cf-aig-gateway-id": config.gatewayId ?? "",
    "cf-aig-collect-log-payload": collectPayloadHeader(),
  };
}

function providerFailure(status: number): ProviderError {
  return new ProviderError(`Cloudflare request failed with HTTP ${status}`, "Cloudflare");
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw providerFailure(response.status);
  try {
    return (await response.json()) as T;
  } catch {
    throw new ProviderError("Cloudflare returned an invalid JSON response", "Cloudflare");
  }
}

function nativeUrl(accountId: string, model: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
}

function gatewayUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run`;
}

export async function runCloudflareJson<T>(
  model: string,
  input: Record<string, unknown>,
): Promise<T> {
  const config = requireCloudflareConfig();
  const useGateway = Boolean(config.gatewayId);
  const response = await globalThis.fetch(
    useGateway ? gatewayUrl(config.accountId) : nativeUrl(config.accountId, model),
    {
      method: "POST",
      headers: useGateway
        ? gatewayHeaders(config)
        : { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(useGateway ? { model, input } : input),
    },
  );
  const payload = await readJson<CloudflareResponse<T>>(response);
  if (payload.success === false || payload.result === undefined) {
    throw new ProviderError("Cloudflare returned no usable result", "Cloudflare");
  }
  return payload.result;
}

export async function runCloudflareBytes(
  model: string,
  input: Record<string, unknown>,
): Promise<Uint8Array> {
  const config = requireCloudflareConfig();
  const useGateway = Boolean(config.gatewayId);
  const response = await globalThis.fetch(
    useGateway ? gatewayUrl(config.accountId) : nativeUrl(config.accountId, model),
    {
      method: "POST",
      headers: useGateway
        ? gatewayHeaders(config)
        : { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(useGateway ? { model, input } : input),
    },
  );
  if (!response.ok) throw providerFailure(response.status);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("audio/mpeg")) {
    throw new ProviderError("Cloudflare did not return MPEG audio", "Cloudflare");
  }
  return new Uint8Array(await response.arrayBuffer());
}

function videoUrl(config: CloudflareVideoConfig, suffix = ""): string {
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(config.accountId)}/${encodeURIComponent(config.gatewayId)}/replicate/predictions${suffix}`;
}

function videoHeaders(config: CloudflareVideoConfig, wait = false): Record<string, string> {
  return {
    Authorization: `Bearer ${config.replicateApiToken}`,
    "cf-aig-authorization": `Bearer ${config.apiToken}`,
    "cf-aig-collect-log-payload": collectPayloadHeader(),
    "Content-Type": "application/json",
    ...(wait ? { Prefer: "wait" } : {}),
  };
}

function prediction(value: unknown): CloudflareVideoPrediction {
  if (!value || typeof value !== "object") {
    throw new ProviderError("Cloudflare returned an invalid video prediction", "Cloudflare");
  }
  const result = value as Partial<CloudflareVideoPrediction>;
  if (typeof result.id !== "string" || typeof result.status !== "string") {
    throw new ProviderError("Cloudflare returned an invalid video prediction", "Cloudflare");
  }
  if (
    result.output !== undefined &&
    typeof result.output !== "string" &&
    (!Array.isArray(result.output) || !result.output.every((item) => typeof item === "string"))
  ) {
    throw new ProviderError("Cloudflare returned an invalid video output", "Cloudflare");
  }
  return { id: result.id, status: result.status, output: result.output };
}

export async function createVideoPrediction(
  input: Record<string, unknown>,
  wait = false,
): Promise<CloudflareVideoPrediction> {
  const config = requireCloudflareVideoConfig();
  const response = await globalThis.fetch(videoUrl(config), {
    method: "POST",
    headers: videoHeaders(config, wait),
    body: JSON.stringify({ version: CLOUDFLARE_VIDEO_MODEL, input }),
  });
  return prediction(await readJson<unknown>(response));
}

export async function getVideoPrediction(id: string): Promise<CloudflareVideoPrediction> {
  const config = requireCloudflareVideoConfig();
  const response = await globalThis.fetch(videoUrl(config, `/${encodeURIComponent(id)}`), {
    headers: videoHeaders(config),
  });
  return prediction(await readJson<unknown>(response));
}

export async function downloadVideo(url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await globalThis.fetch(url);
  } catch {
    throw new ProviderError("Cloudflare video download could not be started", "Cloudflare");
  }
  if (!response.ok)
    throw new ProviderError(
      `Cloudflare video download failed with HTTP ${response.status}`,
      "Cloudflare",
    );
  return new Uint8Array(await response.arrayBuffer());
}
