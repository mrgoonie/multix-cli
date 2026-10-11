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
 * Files never overwrite an existing variable, so earlier layers always win.
 * Set MULTIX_DISABLE_HOME_ENV=1 to skip every file under the home directory
 * (used in tests).
 *
 * The loader records which file supplied each variable so that endpoint
 * overrides (`*_BASE_URL`) from a project `.env` can be refused: see
 * resolveBaseUrl.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as dotenvParse } from "dotenv";

/** Where a file-loaded variable came from. Variables with no record came from the shell. */
export type EnvFileSource = "project" | "user" | "legacy";

let loaded = false;
let loadedFiles: string[] = [];
/** Variables set by loadEnv, with the file that supplied them. */
let fileOrigins = new Map<string, { source: EnvFileSource; file: string; value: string }>();
/** Every value in the user-level env file, including ones a project file shadowed. */
let userFileValues: Record<string, string> = {};
/** Variable names already warned about in this run. */
let warned = new Set<string>();

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
  return isTruthy(env.MULTIX_LEGACY_CLAUDE_ENV);
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

function parseFile(file: string): Record<string, string> | undefined {
  if (!isReadableFile(file)) return undefined;
  try {
    return dotenvParse(fs.readFileSync(file));
  } catch {
    return undefined;
  }
}

/** Load a file without overriding anything, recording the origin of each new variable. */
function loadFile(
  file: string,
  source: EnvFileSource,
  accept: (name: string) => boolean = () => true,
): Record<string, string> | undefined {
  const parsed = parseFile(file);
  if (!parsed) return undefined;
  for (const [name, value] of Object.entries(parsed)) {
    if (!accept(name) || process.env[name] !== undefined) continue;
    process.env[name] = value;
    fileOrigins.set(name, { source, file, value });
  }
  loadedFiles.push(file);
  return parsed;
}

/** Load .env files once. Safe to call multiple times. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  loadedFiles = [];
  fileOrigins = new Map();
  userFileValues = {};

  const cwd = process.cwd();
  const home = process.env.MULTIX_DISABLE_HOME_ENV ? undefined : os.homedir();

  // cwd/.env — never overrides existing process.env vars
  loadFile(path.resolve(cwd, ".env"), "project");

  // ~/.multix/.env — skip in test mode
  if (home) userFileValues = loadFile(path.join(home, ".multix", ".env"), "user") ?? {};

  // Opt-in compatibility for old AgentKit installs. Checked after the files
  // above so the flag itself may live in cwd/.env or ~/.multix/.env.
  if (legacyClaudeEnvEnabled()) {
    for (const file of legacyClaudeEnvFiles(cwd, home)) {
      loadFile(file, "legacy", isLegacyAllowedName);
    }
  }
}

/**
 * The env file that supplied `name`, or undefined when the current value came
 * from the shell (or was set at runtime after loading).
 */
export function envFileOrigin(name: string): { source: EnvFileSource; file: string } | undefined {
  const origin = fileOrigins.get(name);
  if (!origin || process.env[name] !== origin.value) return undefined;
  return { source: origin.source, file: origin.file };
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** Opt-in env var that lets a project `.env` set `*_BASE_URL` overrides. */
export const ALLOW_PROJECT_BASE_URL_ENV = "MULTIX_ALLOW_PROJECT_BASE_URL";

/** True when the opt-in is set in the shell or the user-level env file (never a project file). */
export function projectBaseUrlAllowed(): boolean {
  if (!isTruthy(process.env[ALLOW_PROJECT_BASE_URL_ENV])) return false;
  return envFileOrigin(ALLOW_PROJECT_BASE_URL_ENV)?.source !== "project";
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  // stderr keeps stdout machine-readable for commands that print a result.
  console.warn(`⚠ ${message}`);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || "(no host)";
  } catch {
    return "(unparseable URL)";
  }
}

const stripSlash = (url: string) => url.replace(/\/+$/, "");

/**
 * Resolve a provider API root from `name` (e.g. `HEYGEN_BASE_URL`), falling
 * back to `defaultUrl`.
 *
 * A value that comes only from a project `.env` is ignored (with a warning
 * naming the variable and file, never the value) unless
 * MULTIX_ALLOW_PROJECT_BASE_URL is set in the shell or the user-level env
 * file; a value the user-level file also sets is used instead. Whenever a
 * non-default base URL is in effect, one warning per variable names the
 * provider and the hostname only, so a redirected API key is never silent.
 */
export function resolveBaseUrl(name: string, defaultUrl: string): string {
  let value = process.env[name]?.trim() || undefined;
  const origin = envFileOrigin(name);
  if (value && origin?.source === "project" && !projectBaseUrlAllowed()) {
    warnOnce(
      `ignored:${name}`,
      `Ignoring ${name} from project env file ${origin.file}: base URL overrides from a project .env are not trusted. Set ${ALLOW_PROJECT_BASE_URL_ENV}=1 in your shell or ~/.multix/.env to allow it.`,
    );
    value = userFileValues[name]?.trim() || undefined;
  }
  if (!value || stripSlash(value) === stripSlash(defaultUrl)) return defaultUrl;
  const provider = name.replace(/_BASE_URL$/, "");
  warnOnce(
    `custom:${name}`,
    `${name} is set: ${provider} API requests, including your API key, go to ${hostOf(value)} instead of the default host.`,
  );
  return value;
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
  fileOrigins = new Map();
  userFileValues = {};
  warned = new Set();
}
