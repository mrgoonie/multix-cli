import { resolveKey } from "../../core/env-loader.js";
import { ProviderError } from "../../core/errors.js";
import { fetchSameOrigin } from "../../core/redirect-fetch.js";
import {
  type CloudflareConfig,
  requireCloudflareConfig,
  requireCloudflareVideoConfig,
} from "./models.js";
import {
  type CloudflareVideoPrediction,
  cloudflareResponseFailure,
  createCloudflareVideoPrediction,
  getCloudflareVideoPrediction,
  readCloudflareJson,
} from "./video-client.js";

export type { CloudflareVideoPrediction } from "./video-client.js";

interface CloudflareResponse<T> {
  result?: T;
  success?: boolean;
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
  const response = await fetchSameOrigin(
    useGateway ? gatewayUrl(config.accountId) : nativeUrl(config.accountId, model),
    {
      method: "POST",
      headers: useGateway
        ? gatewayHeaders(config)
        : { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(useGateway ? { model, input } : input),
    },
  );
  const payload = await readCloudflareJson<CloudflareResponse<T>>(response);
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
  const response = await fetchSameOrigin(
    useGateway ? gatewayUrl(config.accountId) : nativeUrl(config.accountId, model),
    {
      method: "POST",
      headers: useGateway
        ? gatewayHeaders(config)
        : { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(useGateway ? { model, input } : input),
    },
  );
  if (!response.ok) throw await cloudflareResponseFailure(response);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("audio/mpeg")) {
    throw new ProviderError("Cloudflare did not return MPEG audio", "Cloudflare");
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function createVideoPrediction(
  input: Record<string, unknown>,
  wait = false,
): Promise<CloudflareVideoPrediction> {
  return createCloudflareVideoPrediction(requireCloudflareVideoConfig(), input, {
    wait,
    collectLogPayload: collectPayloadHeader() === "true",
  });
}

export async function getVideoPrediction(id: string): Promise<CloudflareVideoPrediction> {
  return getCloudflareVideoPrediction(requireCloudflareVideoConfig(), id, {
    collectLogPayload: collectPayloadHeader() === "true",
  });
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
