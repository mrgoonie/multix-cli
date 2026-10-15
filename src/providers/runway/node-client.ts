/**
 * Node-only wiring for the Runway client: env resolution and defaults.
 * Secret: RUNWAYML_API_SECRET (the name the official SDKs read).
 * RUNWAY_BASE_URL overrides the API root (mock servers, proxies, tests) and
 * follows the same trust rules as every other provider base URL.
 */

import { resolveKey, resolveProviderBaseUrl, resolveRoutedKey } from "../../core/env-loader.js";
import { ConfigError } from "../../core/errors.js";
import { RunwayClient } from "./client.js";
import {
  DEFAULT_RUNWAY_IMAGE_MODEL,
  DEFAULT_RUNWAY_VIDEO_MODEL,
  RUNWAY_KEY_LINK,
  RUNWAY_ROUTING,
} from "./models.js";

export const [RUNWAY_SECRET_ENV] = RUNWAY_ROUTING.keyEnvs;
export const RUNWAY_VIDEO_MODEL_ENV = "RUNWAY_VIDEO_MODEL";
export const RUNWAY_IMAGE_MODEL_ENV = "RUNWAY_IMAGE_MODEL";

export function requireRunwaySecret(): string {
  const secret = resolveRoutedKey(RUNWAY_ROUTING);
  if (!secret) {
    throw new ConfigError(
      `${RUNWAY_SECRET_ENV} is not set. Create an API key at ${RUNWAY_KEY_LINK}`,
    );
  }
  return secret;
}

export function runwayBaseUrl(): string {
  return resolveProviderBaseUrl(RUNWAY_ROUTING);
}

export function runwayVideoModel(): string {
  return resolveKey(RUNWAY_VIDEO_MODEL_ENV)?.trim() || DEFAULT_RUNWAY_VIDEO_MODEL;
}

export function runwayImageModel(): string {
  return resolveKey(RUNWAY_IMAGE_MODEL_ENV)?.trim() || DEFAULT_RUNWAY_IMAGE_MODEL;
}

/** Build a client from env. Throws ConfigError when no secret is configured. */
export function createRunwayClient(): RunwayClient {
  return new RunwayClient({ apiKey: requireRunwaySecret(), baseUrl: runwayBaseUrl() });
}
