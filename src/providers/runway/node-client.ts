/**
 * Node-only wiring for the Runway client: env resolution and defaults.
 * Key: RUNWAYML_API_SECRET (the name Runway's SDKs read).
 * RUNWAY_BASE_URL overrides the API root (mock servers, proxies, tests).
 * MULTIX_UPLOAD_MIN_KBPS (shared with Gemini) scales the create timeout for
 * requests that carry inline images.
 */

import { resolveKey, resolveProviderBaseUrl } from "../../core/env-loader.js";
import { ConfigError } from "../../core/errors.js";
import { minUploadBytesPerSec } from "../gemini/local-files.js";
import { RunwayClient } from "./client.js";
import {
  DEFAULT_RUNWAY_IMAGE_MODEL,
  DEFAULT_RUNWAY_VIDEO_MODEL,
  RUNWAY_DASHBOARD_LINK,
  RUNWAY_ROUTING,
} from "./models.js";

export const [RUNWAY_SECRET_ENV] = RUNWAY_ROUTING.keyEnvs;

export function requireRunwaySecret(): string {
  const secret = resolveKey(RUNWAY_SECRET_ENV)?.trim();
  if (!secret) {
    throw new ConfigError(
      `${RUNWAY_SECRET_ENV} is not set. Create an API key at ${RUNWAY_DASHBOARD_LINK}`,
    );
  }
  return secret;
}

export function runwayBaseUrl(): string {
  return resolveProviderBaseUrl(RUNWAY_ROUTING);
}

export function runwayVideoModel(): string {
  return resolveKey("RUNWAY_VIDEO_MODEL")?.trim() || DEFAULT_RUNWAY_VIDEO_MODEL;
}

export function runwayImageModel(): string {
  return resolveKey("RUNWAY_IMAGE_MODEL")?.trim() || DEFAULT_RUNWAY_IMAGE_MODEL;
}

/** Build a client from env. Throws ConfigError when no API secret is configured. */
export function createRunwayClient(): RunwayClient {
  return new RunwayClient({
    apiKey: requireRunwaySecret(),
    baseUrl: runwayBaseUrl(),
    minUploadBytesPerSec: minUploadBytesPerSec(),
  });
}
