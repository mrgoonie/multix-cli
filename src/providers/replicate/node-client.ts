/**
 * Node-only wiring for the Replicate client: env resolution and defaults.
 * Token: REPLICATE_API_TOKEN (official name), falling back to REPLICATE_API_KEY.
 * REPLICATE_BASE_URL overrides the API root (mock servers, proxies, tests).
 */

import { resolveKey } from "../../core/env-loader.js";
import { ConfigError } from "../../core/errors.js";
import { ReplicateClient } from "./client.js";
import {
  DEFAULT_REPLICATE_BASE_URL,
  DEFAULT_REPLICATE_IMAGE_MODEL,
  DEFAULT_REPLICATE_VIDEO_MODEL,
} from "./models.js";

export const REPLICATE_TOKEN_ENV = "REPLICATE_API_TOKEN";
export const REPLICATE_TOKEN_FALLBACK_ENV = "REPLICATE_API_KEY";

/** The configured token and which env var supplied it, or undefined. */
export function resolveReplicateToken(): { token: string; envUsed: string } | undefined {
  for (const name of [REPLICATE_TOKEN_ENV, REPLICATE_TOKEN_FALLBACK_ENV]) {
    const value = resolveKey(name)?.trim();
    if (value) return { token: value, envUsed: name };
  }
  return undefined;
}

export function requireReplicateToken(): string {
  const resolved = resolveReplicateToken();
  if (!resolved) {
    throw new ConfigError(
      `${REPLICATE_TOKEN_ENV} is not set (${REPLICATE_TOKEN_FALLBACK_ENV} is also accepted). Get one at https://replicate.com/account/api-tokens`,
    );
  }
  return resolved.token;
}

export function replicateBaseUrl(): string {
  return resolveKey("REPLICATE_BASE_URL")?.trim() || DEFAULT_REPLICATE_BASE_URL;
}

export function replicateImageModel(): string {
  return resolveKey("REPLICATE_IMAGE_MODEL")?.trim() || DEFAULT_REPLICATE_IMAGE_MODEL;
}

export function replicateVideoModel(): string {
  return resolveKey("REPLICATE_VIDEO_MODEL")?.trim() || DEFAULT_REPLICATE_VIDEO_MODEL;
}

/** Build a client from env. Throws ConfigError when no token is configured. */
export function createReplicateClient(): ReplicateClient {
  return new ReplicateClient({ apiKey: requireReplicateToken(), baseUrl: replicateBaseUrl() });
}
