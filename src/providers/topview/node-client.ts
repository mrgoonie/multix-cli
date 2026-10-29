/**
 * Node-only wiring for the two TopView clients: env resolution and defaults.
 *
 * Legacy API: TOPVIEW_API_KEY (secret) + TOPVIEW_UID (account identifier),
 * TOPVIEW_BASE_URL override. API Platform: TOPVIEW_PLATFORM_API_KEY,
 * TOPVIEW_PLATFORM_BASE_URL override. The keys and balances are separate;
 * a command never falls back from one key to the other.
 * MULTIX_UPLOAD_MIN_KBPS (shared with Gemini) scales the upload timeout.
 */

import { resolveKey, resolveProviderBaseUrl } from "../../core/env-loader.js";
import { ConfigError } from "../../core/errors.js";
import { minUploadBytesPerSec } from "../gemini/local-files.js";
import { TopviewLegacyClient } from "./legacy-client.js";
import {
  TOPVIEW_API_SETTINGS_LINK,
  TOPVIEW_PLATFORM_CONSOLE_LINK,
  TOPVIEW_PLATFORM_ROUTING,
  TOPVIEW_ROUTING,
  TOPVIEW_UID_ENV,
} from "./models.js";
import { TopviewPlatformClient } from "./platform-client.js";

export const [TOPVIEW_API_KEY_ENV] = TOPVIEW_ROUTING.keyEnvs;
export const [TOPVIEW_PLATFORM_API_KEY_ENV] = TOPVIEW_PLATFORM_ROUTING.keyEnvs;

function required(name: string, where: string): string {
  const value = resolveKey(name)?.trim();
  if (!value) throw new ConfigError(`${name} is not set. ${where}`);
  return value;
}

export function topviewBaseUrl(): string {
  return resolveProviderBaseUrl(TOPVIEW_ROUTING);
}

export function topviewPlatformBaseUrl(): string {
  return resolveProviderBaseUrl(TOPVIEW_PLATFORM_ROUTING);
}

/** Legacy API client from env. Throws ConfigError when the key or the Uid is missing. */
export function createTopviewLegacyClient(): TopviewLegacyClient {
  const where = `Find your Topview Uid and API key under API Settings at ${TOPVIEW_API_SETTINGS_LINK} (Legacy API; the API Platform key does not work here)`;
  return new TopviewLegacyClient({
    apiKey: required(TOPVIEW_API_KEY_ENV, where),
    uid: required(TOPVIEW_UID_ENV, where),
    baseUrl: topviewBaseUrl(),
    minUploadBytesPerSec: minUploadBytesPerSec(),
  });
}

/** API Platform client from env. Throws ConfigError when the platform key is missing. */
export function createTopviewPlatformClient(): TopviewPlatformClient {
  return new TopviewPlatformClient({
    apiKey: required(
      TOPVIEW_PLATFORM_API_KEY_ENV,
      `Create a key under API keys at ${TOPVIEW_PLATFORM_CONSOLE_LINK} (API Platform; the Legacy TOPVIEW_API_KEY does not work here)`,
    ),
    baseUrl: topviewPlatformBaseUrl(),
  });
}
