/**
 * Node-only wiring for the Sume client: env resolution.
 * Key: SUME_API_KEY. SUME_BASE_URL overrides the API root (mock servers,
 * proxies, tests); the public catalogue and quote always use api.sume.com.
 */

import { resolveKey, resolveProviderBaseUrl } from "../../core/env-loader.js";
import { ConfigError } from "../../core/errors.js";
import { SumeClient } from "./client.js";
import { SUME_DASHBOARD_LINK, SUME_ROUTING } from "./models.js";

export const [SUME_KEY_ENV] = SUME_ROUTING.keyEnvs;

export function requireSumeKey(): string {
  const key = resolveKey(SUME_KEY_ENV)?.trim();
  if (!key) {
    throw new ConfigError(
      `${SUME_KEY_ENV} is not set. Create an API key in the Sume dashboard (${SUME_DASHBOARD_LINK})`,
    );
  }
  return key;
}

export function sumeBaseUrl(): string {
  return resolveProviderBaseUrl(SUME_ROUTING);
}

/** Build a client from env. Throws ConfigError when no API key is configured. */
export function createSumeClient(): SumeClient {
  return new SumeClient({ apiKey: requireSumeKey(), baseUrl: sumeBaseUrl() });
}
