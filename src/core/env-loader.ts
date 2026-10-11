/**
 * Environment variable loader for multix CLI.
 *
 * Resolution priority (highest to lowest):
 * 1. process.env (already set at startup — never overwrite)
 * 2. cwd/.env
 * 3. ~/.multix/.env
 * 4. Legacy Claude/AgentKit layers, only when MULTIX_LEGACY_CLAUDE_ENV=1
 *    (see legacyClaudeEnvFiles for their order)
 *
 * dotenv is called with override:false so earlier layers always win.
 * Set MULTIX_DISABLE_HOME_ENV=1 to skip every file under the home directory
 * (used in tests).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config as dotenvConfig } from "dotenv";

let loaded = false;
let loadedFiles: string[] = [];

/** Skill folders the legacy AgentKit Python backend read its .env from. */
const LEGACY_SKILL_DIRS = ["ai-multimodal", "ak-ai-multimodal"];

/**
 * Legacy `.claude` env files for one root, most specific first:
 * skill-specific .env, then .claude/skills/.env, then .claude/.env.
 */
function legacyFilesUnder(root: string): string[] {
  const claude = path.join(root, ".claude");
  return [
    ...LEGACY_SKILL_DIRS.map((dir) => path.join(claude, "skills", dir, ".env")),
    path.join(claude, "skills", ".env"),
    path.join(claude, ".env"),
  ];
}

/** Legacy candidates: project layers first, then the same layers under home. */
export function legacyClaudeEnvFiles(cwd: string, home?: string): string[] {
  const files = legacyFilesUnder(cwd);
  if (home && path.resolve(home) !== path.resolve(cwd)) files.push(...legacyFilesUnder(home));
  return files;
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function loadFile(file: string): void {
  if (!fs.existsSync(file)) return;
  dotenvConfig({ path: file, override: false });
  loadedFiles.push(file);
}

/** Load .env files once. Safe to call multiple times. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  loadedFiles = [];

  const cwd = process.cwd();
  const home = process.env.MULTIX_DISABLE_HOME_ENV ? undefined : os.homedir();

  // cwd/.env — override:false keeps existing process.env vars
  loadFile(path.resolve(cwd, ".env"));

  // ~/.multix/.env — skip in test mode
  if (home) loadFile(path.join(home, ".multix", ".env"));

  // Opt-in compatibility for old AgentKit installs. Checked after the files
  // above so the flag itself may live in cwd/.env or ~/.multix/.env.
  if (isTruthy(process.env.MULTIX_LEGACY_CLAUDE_ENV)) {
    for (const file of legacyClaudeEnvFiles(cwd, home)) loadFile(file);
  }
}

/** Env files that loadEnv actually read, in load order (paths only, never values). */
export function getLoadedEnvFiles(): string[] {
  return [...loadedFiles];
}

/**
 * Resolve a single environment variable by name.
 * Returns undefined if not set (after env loading).
 */
export function resolveKey(name: string): string | undefined {
  return process.env[name] || undefined;
}

export { redact } from "./redact.js";

/** Reset loaded state — for testing only. */
export function _resetEnvLoader(): void {
  loaded = false;
  loadedFiles = [];
}
