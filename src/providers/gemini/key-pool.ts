/**
 * Gemini API key rotation.
 *
 * Keys come from GEMINI_API_KEY followed by GEMINI_API_KEY_2, GEMINI_API_KEY_3, …
 * (any numeric suffix, ascending; duplicate values are dropped). Each call starts
 * with the first key that is not cooling down. A quota/rate-limit failure
 * (HTTP 429 or RESOURCE_EXHAUSTED) puts that key on cooldown for the server's
 * Retry-After, or 60s, and the same operation is retried with the next key.
 * Cooldowns live in process memory only. Logs name env vars, never key values.
 */

import { ConfigError, HttpError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";

export const PRIMARY_KEY_ENV = "GEMINI_API_KEY";
export const DEFAULT_COOLDOWN_MS = 60_000;

export interface GeminiKey {
  /** Env var the key came from, safe to log. */
  name: string;
  value: string;
}

const cooldownUntil = new Map<string, number>();

/** All configured Gemini keys in rotation order. */
export function listGeminiKeys(env: NodeJS.ProcessEnv = process.env): GeminiKey[] {
  const numbered = Object.keys(env)
    .map((name) => ({ name, match: /^GEMINI_API_KEY_(\d+)$/.exec(name) }))
    .filter((e): e is { name: string; match: RegExpExecArray } => e.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map((e) => e.name);

  const seen = new Set<string>();
  const keys: GeminiKey[] = [];
  for (const name of [PRIMARY_KEY_ENV, ...numbered]) {
    const value = env[name]?.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    keys.push({ name, value });
  }
  return keys;
}

/** True for quota and rate-limit failures that another key may not hit. */
export function isGeminiRateLimitError(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 429 || error.snippet.includes("RESOURCE_EXHAUSTED");
  }
  if (error instanceof Error) {
    return /\b429\b|RESOURCE_EXHAUSTED/.test(error.message);
  }
  return false;
}

function cooldownMs(error: unknown): number {
  if (error instanceof HttpError && error.retryAfterMs !== undefined && error.retryAfterMs > 0) {
    return error.retryAfterMs;
  }
  return DEFAULT_COOLDOWN_MS;
}

/** Keys not cooling down first (configured order), then cooling keys by soonest expiry. */
function orderKeys(keys: GeminiKey[], now: number): GeminiKey[] {
  const until = (k: GeminiKey) => cooldownUntil.get(k.value) ?? 0;
  const ready = keys.filter((k) => until(k) <= now);
  const cooling = keys.filter((k) => until(k) > now).sort((a, b) => until(a) - until(b));
  return [...ready, ...cooling];
}

/**
 * Run `fn` with a Gemini key, rotating to the next key on rate-limit errors.
 * Multi-step flows (upload then generate, Veo submit/poll/download) must run
 * entirely inside one `fn` so every step uses the same key.
 */
export async function withGeminiKey<T>(
  fn: (apiKey: string, keyName: string) => Promise<T>,
  opts: { logger?: Logger; env?: NodeJS.ProcessEnv; now?: () => number } = {},
): Promise<T> {
  const now = opts.now ?? Date.now;
  const keys = listGeminiKeys(opts.env);
  if (keys.length === 0) {
    throw new ConfigError(
      "GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey",
    );
  }

  const ordered = orderKeys(keys, now());
  let lastError: unknown;
  for (const [i, key] of ordered.entries()) {
    try {
      return await fn(key.value, key.name);
    } catch (error) {
      if (!isGeminiRateLimitError(error)) throw error;
      lastError = error;
      cooldownUntil.set(key.value, now() + cooldownMs(error));
      const next = ordered[i + 1];
      if (next) opts.logger?.warn(`${key.name} is rate-limited; retrying with ${next.name}`);
    }
  }
  if (keys.length > 1) opts.logger?.warn(`All ${keys.length} Gemini keys are rate-limited`);
  throw lastError;
}

/** Reset cooldown state — for testing only. */
export function _resetGeminiKeyCooldowns(): void {
  cooldownUntil.clear();
}
