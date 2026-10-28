/**
 * Node-only wiring for the TopView clients: env resolution.
 * - Legacy API (credits): TOPVIEW_API_KEY + TOPVIEW_UID; TOPVIEW_BASE_URL overrides the root.
 * - API Platform (USD): TOPVIEW_PLATFORM_API_KEY; TOPVIEW_PLATFORM_BASE_URL overrides the root.
 * The two surfaces have separate keys and balances; neither falls back to the other.
 */

import { resolveKey, resolveProviderBaseUrl } from "../../core/env-loader.js";
import { ConfigError } from "../../core/errors.js";
import { TopviewClient } from "./client.js";
import {
  TOPVIEW_DASHBOARD_LINK,
  TOPVIEW_PLATFORM_DASHBOARD_LINK,
  TOPVIEW_PLATFORM_ROUTING,
  TOPVIEW_ROUTING,
  TOPVIEW_UID_ENV,
} from "./models.js";
import { TopviewPlatformClient } from "./platform-client.js";

export const [TOPVIEW_KEY_ENV] = TOPVIEW_ROUTING.keyEnvs;
export const [TOPVIEW_PLATFORM_KEY_ENV] = TOPVIEW_PLATFORM_ROUTING.keyEnvs;

function requireEnv(name: string, hint: string): string {
  const value = resolveKey(name)?.trim();
  if (!value) throw new ConfigError(`${name} is not set. ${hint}`);
  return value;
}

/** Build the legacy client. Throws ConfigError when the key or UID is missing. */
export function createTopviewClient(): TopviewClient {
  const hint = `Find the API key and UID under API Settings at ${TOPVIEW_DASHBOARD_LINK}`;
  return new TopviewClient({
    apiKey: requireEnv(TOPVIEW_KEY_ENV, hint),
    uid: requireEnv(TOPVIEW_UID_ENV, hint),
    baseUrl: resolveProviderBaseUrl(TOPVIEW_ROUTING),
  });
}

/** Build the API Platform client. Throws ConfigError when the key is missing. */
export function createTopviewPlatformClient(): TopviewPlatformClient {
  return new TopviewPlatformClient({
    apiKey: requireEnv(
      TOPVIEW_PLATFORM_KEY_ENV,
      `Create an API Platform key at ${TOPVIEW_PLATFORM_DASHBOARD_LINK} (legacy TOPVIEW_API_KEY does not work there)`,
    ),
    baseUrl: resolveProviderBaseUrl(TOPVIEW_PLATFORM_ROUTING),
  });
}
