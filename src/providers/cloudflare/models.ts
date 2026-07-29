import { resolveKey } from "../../core/env-loader.js";
import { ConfigError, ValidationError } from "../../core/errors.js";

export const CLOUDFLARE_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
export const CLOUDFLARE_TTS_MODEL = "@cf/myshell-ai/melotts";
export const CLOUDFLARE_VIDEO_MODEL = "prunaai/p-video";

type NativeMediaKind = "image" | "speech";

export interface CloudflareConfig {
  accountId: string;
  apiToken: string;
  gatewayId?: string;
}

export interface CloudflareVideoConfig extends Required<CloudflareConfig> {
  replicateApiToken: string;
}

function required(name: string): string {
  const value = resolveKey(name)?.trim();
  if (!value) throw new ConfigError(`${name} is required for Cloudflare media generation`);
  return value;
}

export function getCloudflareModel(kind: NativeMediaKind, requested?: string): string {
  const expected = kind === "image" ? CLOUDFLARE_IMAGE_MODEL : CLOUDFLARE_TTS_MODEL;
  const overrideName = kind === "image" ? "CLOUDFLARE_AI_IMAGE_MODEL" : "CLOUDFLARE_AI_TTS_MODEL";
  const model = requested ?? resolveKey(overrideName) ?? expected;
  if (model !== expected) {
    throw new ValidationError(`Unsupported Cloudflare ${kind} model: ${model}`);
  }
  return model;
}

export function validateImageSteps(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new ValidationError("--steps must be an integer from 1 to 8 for flux-1-schnell");
  }
  const steps = Number.parseInt(value, 10);
  if (!Number.isInteger(steps) || steps < 1 || steps > 8) {
    throw new ValidationError("--steps must be an integer from 1 to 8 for flux-1-schnell");
  }
  return steps;
}

export function requireCloudflareConfig(): CloudflareConfig {
  return {
    accountId: required("CLOUDFLARE_ACCOUNT_ID"),
    apiToken: required("CLOUDFLARE_API_TOKEN"),
    gatewayId: resolveKey("CLOUDFLARE_AI_GATEWAY_ID")?.trim() || undefined,
  };
}

export function requireCloudflareVideoConfig(): CloudflareVideoConfig {
  const config = requireCloudflareConfig();
  if (!config.gatewayId) {
    throw new ConfigError("CLOUDFLARE_AI_GATEWAY_ID is required for Cloudflare video generation");
  }
  return {
    ...config,
    gatewayId: config.gatewayId,
    replicateApiToken: required("REPLICATE_API_TOKEN"),
  };
}
