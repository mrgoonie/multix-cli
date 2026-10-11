import { envDefault } from "../../core/env-default.js";
import {
  type TrustedSettingState,
  applyTrustedSetting,
  inspectTrustedSetting,
  resolveKey,
  trustedSettingRefusal,
} from "../../core/env-loader.js";
import { ConfigError, ValidationError } from "../../core/errors.js";
import { CLOUDFLARE_IMAGE_MODEL, CLOUDFLARE_TTS_MODEL } from "./model-ids.js";
import type { CloudflareVideoConfig } from "./video-client.js";

export {
  CLOUDFLARE_IMAGE_MODEL,
  CLOUDFLARE_TTS_MODEL,
  CLOUDFLARE_VIDEO_MODEL,
} from "./model-ids.js";
export type { CloudflareVideoConfig } from "./video-client.js";

type NativeMediaKind = "image" | "speech";

export interface CloudflareConfig {
  accountId: string;
  apiToken: string;
  gatewayId?: string;
}

export const CLOUDFLARE_ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";
export const CLOUDFLARE_GATEWAY_ID_ENV = "CLOUDFLARE_AI_GATEWAY_ID";
const CLOUDFLARE_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";
/** Gateway video reads only this name (never REPLICATE_API_KEY). */
const GATEWAY_REPLICATE_TOKEN_ENV = "REPLICATE_API_TOKEN";

/** Credentials sent by native Workers AI calls and, additionally, by gateway video. */
export const CLOUDFLARE_NATIVE_CREDENTIALS = [CLOUDFLARE_TOKEN_ENV] as const;
export const CLOUDFLARE_VIDEO_CREDENTIALS = [
  CLOUDFLARE_TOKEN_ENV,
  GATEWAY_REPLICATE_TOKEN_ENV,
] as const;

/** Which Cloudflare commands: native image and speech, or gateway video. */
export type CloudflareUse = "native" | "video";

export function getCloudflareModel(kind: NativeMediaKind, requested?: string): string {
  const expected = kind === "image" ? CLOUDFLARE_IMAGE_MODEL : CLOUDFLARE_TTS_MODEL;
  const overrideName = kind === "image" ? "CLOUDFLARE_AI_IMAGE_MODEL" : "CLOUDFLARE_AI_TTS_MODEL";
  const model = requested ?? envDefault(overrideName, expected);
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

/** What a Cloudflare command would do with the current environment, without acting on it. */
export interface CloudflareConfigCheck {
  /** The ConfigError message the command would stop with, or undefined when it can run. */
  problem?: string;
  /** True when `problem` comes from the project trust rule (not a missing setting). */
  refused: boolean;
  accountId: TrustedSettingState;
  gatewayId: TrustedSettingState;
}

const requiredMessage = (name: string) => `${name} is required for Cloudflare media generation`;
const token = (name: string) => resolveKey(name)?.trim() || undefined;

/**
 * Account and gateway IDs choose whose Cloudflare tenant receives the tokens,
 * so they are read like base URLs: a project .env value is trusted only when
 * every token the command sends comes from that same file (see
 * inspectTrustedSetting). The commands and `multix check` both use this, so
 * check reports exactly what the command will do.
 */
export function inspectCloudflareConfig(use: CloudflareUse = "native"): CloudflareConfigCheck {
  const credentials =
    use === "video" ? CLOUDFLARE_VIDEO_CREDENTIALS : CLOUDFLARE_NATIVE_CREDENTIALS;
  const accountId = inspectTrustedSetting(CLOUDFLARE_ACCOUNT_ID_ENV, credentials);
  const gatewayId = inspectTrustedSetting(CLOUDFLARE_GATEWAY_ID_ENV, credentials);
  const result = (problem?: string, refused = false): CloudflareConfigCheck => ({
    problem,
    refused,
    accountId,
    gatewayId,
  });
  // Same order the command reads them in, so the first problem is the one it reports.
  if (accountId.status === "refused") {
    return result(trustedSettingRefusal(CLOUDFLARE_ACCOUNT_ID_ENV, accountId), true);
  }
  if (accountId.status === "unset") return result(requiredMessage(CLOUDFLARE_ACCOUNT_ID_ENV));
  if (!token(CLOUDFLARE_TOKEN_ENV)) return result(requiredMessage(CLOUDFLARE_TOKEN_ENV));
  if (gatewayId.status === "refused") {
    return result(trustedSettingRefusal(CLOUDFLARE_GATEWAY_ID_ENV, gatewayId), true);
  }
  if (use === "video") {
    if (gatewayId.status === "unset") {
      return result(`${CLOUDFLARE_GATEWAY_ID_ENV} is required for Cloudflare video generation`);
    }
    if (!token(GATEWAY_REPLICATE_TOKEN_ENV)) {
      return result(requiredMessage(GATEWAY_REPLICATE_TOKEN_ENV));
    }
  }
  return result();
}

function requireConfig(use: CloudflareUse): CloudflareConfig & { replicateApiToken?: string } {
  const check = inspectCloudflareConfig(use);
  if (check.problem) throw new ConfigError(check.problem);
  return {
    // applyTrustedSetting prints the one-time warning when a ~/.multix/.env fallback is used.
    accountId: applyTrustedSetting(CLOUDFLARE_ACCOUNT_ID_ENV, check.accountId) as string,
    apiToken: token(CLOUDFLARE_TOKEN_ENV) as string,
    gatewayId: applyTrustedSetting(CLOUDFLARE_GATEWAY_ID_ENV, check.gatewayId),
    ...(use === "video" ? { replicateApiToken: token(GATEWAY_REPLICATE_TOKEN_ENV) } : {}),
  };
}

export function requireCloudflareConfig(): CloudflareConfig {
  return requireConfig("native");
}

export function requireCloudflareVideoConfig(): CloudflareVideoConfig {
  const config = requireConfig("video");
  return {
    accountId: config.accountId,
    apiToken: config.apiToken,
    gatewayId: config.gatewayId as string,
    replicateApiToken: config.replicateApiToken as string,
  };
}
