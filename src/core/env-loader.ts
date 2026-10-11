/**
 * Environment variable loader for multix CLI.
 *
 * Resolution priority (highest to lowest):
 * 1. process.env (already set at startup — never overwrite)
 * 2. cwd/.env
 * 3. ~/.multix/.env
 * 4. Legacy Claude/AgentKit layers, only when MULTIX_LEGACY_CLAUDE_ENV=1
 *    (see legacyClaudeEnvFiles for their order; credential names only)
 *
 * dotenv is called with override:false so earlier layers always win.
 * Set MULTIX_DISABLE_HOME_ENV=1 to skip every file under the home directory
 * (used in tests).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config as dotenvConfig, parse as dotenvParse } from "dotenv";

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

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** Legacy candidates: project layers first, then the same layers under home. */
export function legacyClaudeEnvFiles(cwd: string, home?: string): string[] {
  const files = legacyFilesUnder(cwd);
  if (home && !samePath(home, cwd)) files.push(...legacyFilesUnder(home));
  return files;
}

/** True when MULTIX_LEGACY_CLAUDE_ENV opts in to the legacy `.claude` layers. */
export function legacyClaudeEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.MULTIX_LEGACY_CLAUDE_ENV;
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Legacy `.claude` files often sit in cloned repos and hold unrelated
 * settings, so only credential-shaped names are taken from them. Endpoint,
 * proxy and runtime variables (e.g. *_BASE_URL, HTTPS_PROXY, NODE_OPTIONS)
 * are ignored so a repo cannot redirect a key to another host.
 */
const LEGACY_ALLOWED_NAME =
  /^[A-Z][A-Z0-9_]*_(API_KEY(_\d+)?|API_TOKEN|ACCOUNT_ID|GATEWAY_ID)$|^(FAL_KEY|ARK_API_KEY)$/;

export function isLegacyAllowedName(name: string): boolean {
  return LEGACY_ALLOWED_NAME.test(name);
}

function isReadableFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function loadFile(file: string): void {
  if (!isReadableFile(file)) return;
  const result = dotenvConfig({ path: file, override: false });
  if (!result.error) loadedFiles.push(file);
}

/** Load credential-shaped names from a legacy file without overriding anything. */
function loadLegacyFile(file: string): void {
  if (!isReadableFile(file)) return;
  let parsed: Record<string, string>;
  try {
    parsed = dotenvParse(fs.readFileSync(file));
  } catch {
    return;
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (isLegacyAllowedName(name) && process.env[name] === undefined) process.env[name] = value;
  }
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
  if (legacyClaudeEnvEnabled()) {
    for (const file of legacyClaudeEnvFiles(cwd, home)) loadLegacyFile(file);
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

/**
 * Resolve the first non-blank variable among `names` (values are trimmed).
 * Returns the value and which variable supplied it.
 */
export function resolveFirstKey(
  ...names: string[]
): { value: string; envUsed: string } | undefined {
  for (const name of names) {
    const value = resolveKey(name)?.trim();
    if (value) return { value, envUsed: name };
  }
  return undefined;
}

export { redact } from "./redact.js";

/** Reset loaded state — for testing only. */
export function _resetEnvLoader(): void {
  loaded = false;
  loadedFiles = [];
}
