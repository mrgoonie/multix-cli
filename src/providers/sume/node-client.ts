/**
 * Node-only wiring for the Sume client: env resolution.
 * Key: SUME_API_KEY. SUME_BASE_URL overrides the API root (mock servers,
 * proxies, tests). SUME_IMAGE_MODEL / SUME_VIDEO_MODEL name an optional
 * default model; multix has no built-in one, so without --model or the env
 * the command refuses and points at `multix sume models`.
 * MULTIX_UPLOAD_MIN_KBPS (shared with Gemini) scales the upload timeout.
 */

import { resolveKey, resolveProviderBaseUrl } from "../../core/env-loader.js";
import { ConfigError, ValidationError } from "../../core/errors.js";
import { minUploadBytesPerSec } from "../gemini/local-files.js";
import { SumeClient } from "./client.js";
import {
  SUME_DASHBOARD_LINK,
  SUME_IMAGE_MODEL_ENV,
  SUME_ROUTING,
  SUME_VIDEO_MODEL_ENV,
  assertModelId,
} from "./models.js";
import type { SumeCommandKind } from "./request-plan.js";

export const [SUME_KEY_ENV] = SUME_ROUTING.keyEnvs;

export function requireSumeKey(): string {
  const key = resolveKey(SUME_KEY_ENV)?.trim();
  if (!key) {
    throw new ConfigError(
      `${SUME_KEY_ENV} is not set. Create an API key at ${SUME_DASHBOARD_LINK} (Dashboard → API keys)`,
    );
  }
  return key;
}

export function sumeBaseUrl(): string {
  return resolveProviderBaseUrl(SUME_ROUTING);
}

/** The env name of the optional default model for a command. */
export function sumeModelEnv(kind: SumeCommandKind): string {
  return kind === "image" ? SUME_IMAGE_MODEL_ENV : SUME_VIDEO_MODEL_ENV;
}

/** The model from --model or the env default, or undefined when neither is set. */
export function sumeModelOrUndefined(kind: SumeCommandKind, flag?: string): string | undefined {
  const value = flag?.trim() || resolveKey(sumeModelEnv(kind))?.trim();
  return value || undefined;
}

/** The model a command runs; throws a ValidationError naming the way to pick one. */
export function sumeModelFor(kind: SumeCommandKind, flag?: string): string {
  const model = sumeModelOrUndefined(kind, flag);
  if (!model) {
    throw new ValidationError(
      `sume ${kind} needs a model: pass -m <id> or set ${sumeModelEnv(kind)}. List the ${kind === "image" ? "image" : "video"} models with: multix sume models --kind ${kind}`,
    );
  }
  return assertModelId(model);
}

/** Keyed client from env. Throws ConfigError when no API key is configured. */
export function createSumeClient(): SumeClient {
  return new SumeClient({
    apiKey: requireSumeKey(),
    baseUrl: sumeBaseUrl(),
    minUploadBytesPerSec: minUploadBytesPerSec(),
  });
}

/** Client for the public catalog only: works without a key (and never sends one). */
export function createSumeCatalogClient(): SumeClient {
  return new SumeClient({ baseUrl: sumeBaseUrl() });
}
