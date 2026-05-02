/**
 * Environment variable loader for multix CLI.
 *
 * Resolution priority (highest to lowest):
 * 1. process.env (already set at startup — never overwrite)
 * 2. cwd/.env
 * 3. ~/.multix/.env
 *
 * dotenv is called with override:false so process.env always wins.
 * Set MULTIX_DISABLE_HOME_ENV=1 to skip ~/.multix/.env (used in tests).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config as dotenvConfig } from "dotenv";

let loaded = false;

/** Load .env files once. Safe to call multiple times. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  // cwd/.env — override:false keeps existing process.env vars
  const cwdEnv = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(cwdEnv)) {
    dotenvConfig({ path: cwdEnv, override: false });
  }

  // ~/.multix/.env — skip in test mode
  if (!process.env["MULTIX_DISABLE_HOME_ENV"]) {
    const homeEnv = path.join(os.homedir(), ".multix", ".env");
    if (fs.existsSync(homeEnv)) {
      dotenvConfig({ path: homeEnv, override: false });
    }
  }
}

/**
 * Resolve a single environment variable by name.
 * Returns undefined if not set (after env loading).
 */
export function resolveKey(name: string): string | undefined {
  return process.env[name] || undefined;
}

/**
 * Redact an API key for safe logging: show first 6 + last 4 chars.
 * e.g. "AIzaSy...abcd"
 */
export function redact(key: string): string {
  if (key.length <= 10) return "***";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

/** Reset loaded state — for testing only. */
export function _resetEnvLoader(): void {
  loaded = false;
}
