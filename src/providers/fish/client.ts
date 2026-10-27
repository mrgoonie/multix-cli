/**
 * Fish Audio key lookup for the CLI (reads the environment; the HTTP clients
 * next to this file stay runtime-neutral and take the key as input).
 */

import { resolveKey } from "../../core/env-loader.js";
import { ConfigError } from "../../core/errors.js";
import { FISH_API_KEY_URL } from "./models.js";

export const FISH_API_KEY_ENV = "FISH_API_KEY";

/** Resolve FISH_API_KEY or throw ConfigError (nothing is sent). */
export function requireFishKey(): string {
  const key = resolveKey(FISH_API_KEY_ENV);
  if (!key) {
    throw new ConfigError(`${FISH_API_KEY_ENV} is not set. Get one at ${FISH_API_KEY_URL}`);
  }
  return key;
}
