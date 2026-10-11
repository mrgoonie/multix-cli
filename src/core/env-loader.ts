/**
 * Environment variable loader for multix CLI.
 *
 * Resolution priority (highest to lowest):
 * 1. process.env (already set at startup — never overwrite)
 * 2. cwd/.env (only the names multix reads; see LoadEnvOptions)
 * 3. ~/.multix/.env
 * 4. Legacy Claude/AgentKit layers, only when MULTIX_LEGACY_CLAUDE_ENV=1
 *    (see legacyClaudeEnvFiles for their order; credential names only)
 *
 * Files never overwrite an existing variable, so earlier layers always win.
 * Set MULTIX_DISABLE_HOME_ENV=1 to skip every file under the home directory
 * (used in tests).
 *
 * The loader records which file supplied each variable so that settings that
 * decide where a key is sent (`*_BASE_URL`, Cloudflare account and gateway
 * IDs) from a project `.env` can be refused: see resolveTrustedSetting.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as dotenvParse } from "dotenv";
import { ConfigError } from "./errors.js";

/**
 * Where a file-loaded variable came from. Variables with no record came from
 * the shell. Legacy `.claude` files under the current directory count as
 * "project"; those under the home directory count as "legacy".
 */
export type EnvFileSource = "project" | "user" | "legacy";

/**
 * Key used to record and look up a variable name. Windows env names are
 * case-insensitive (`heygen_base_url` and `HEYGEN_BASE_URL` are the same
 * variable), so names are upper-cased there; elsewhere they are kept as-is.
 */
export function envNameKey(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? name.toUpperCase() : name;
}

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

/**
 * Load a file without overriding anything, recording the origin of each new
 * variable. Names `accept` refuses are skipped and passed to `onRefused`.
 */
function loadFile(
  file: string,
  source: EnvFileSource,
  accept: (name: string) => boolean = () => true,
  onRefused?: (name: string) => void,
): Record<string, string> | undefined {
  const parsed = parseFile(file);
  if (!parsed) return undefined;
  for (const [name, value] of Object.entries(parsed)) {
    if (!accept(name)) {
      onRefused?.(name);
      continue;
    }
    if (process.env[name] !== undefined) continue;
    process.env[name] = value;
    fileOrigins.set(envNameKey(name), { source, file, value });
  }
  loadedFiles.push(file);
  return parsed;
}

/** Parsed file values keyed by envNameKey (first spelling wins, like process.env). */
function byNameKey(values: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(values ?? {})) {
    const key = envNameKey(name);
    if (!(key in out)) out[key] = value;
  }
  return out;
}

export interface LoadEnvOptions {
  /**
   * Names a project env file (cwd/.env, or a legacy `.claude` file under cwd)
   * may set: the variables multix reads (see src/project-env-names.ts). Shell
   * variables and user-level files are not filtered.
   */
  isProjectEnvName: (name: string) => boolean;
}

/**
 * Load .env files once. Safe to call multiple times.
 *
 * Names in cwd/.env that `isProjectEnvName` refuses are never copied into
 * process.env (so they cannot reach spawned tools either); one warning lists
 * them by name, never by value.
 */
export function loadEnv({ isProjectEnvName }: LoadEnvOptions): void {
  if (loaded) return;
  loaded = true;
  loadedFiles = [];
  fileOrigins = new Map();
  userFileValues = {};

  const cwd = process.cwd();
  const home = process.env.MULTIX_DISABLE_HOME_ENV ? undefined : os.homedir();

  // cwd/.env — never overrides existing process.env vars
  const projectFile = path.resolve(cwd, ".env");
  const refused: string[] = [];
  loadFile(projectFile, "project", isProjectEnvName, (name) => refused.push(name));
  if (refused.length > 0) {
    warnOnce(
      "project-env-refused",
      `Ignoring ${refused.length} variable(s) in project env file ${projectFile} that multix does not read: ${refused.join(", ")}. A project .env may only set provider keys and multix settings; set anything else in your shell.`,
    );
  }

  // ~/.multix/.env — skip in test mode
  if (home) userFileValues = byNameKey(loadFile(path.join(home, ".multix", ".env"), "user"));

  // Opt-in compatibility for old AgentKit installs. Checked after the files
  // above so the flag itself may live in cwd/.env or ~/.multix/.env.
  if (legacyClaudeEnvEnabled()) {
    const projectLegacy = new Set(legacyFilesUnder(cwd));
    const projectLegacyName = (name: string) => isLegacyAllowedName(name) && isProjectEnvName(name);
    for (const file of legacyClaudeEnvFiles(cwd, home)) {
      if (projectLegacy.has(file)) loadFile(file, "project", projectLegacyName);
      else loadFile(file, "legacy", isLegacyAllowedName);
    }
  }
}

/**
 * The env file that supplied `name`, or undefined when the current value came
 * from the shell (or was set at runtime after loading). On Windows the lookup
 * ignores case, matching how the OS resolves the variable.
 */
export function envFileOrigin(name: string): { source: EnvFileSource; file: string } | undefined {
  const origin = fileOrigins.get(envNameKey(name));
  if (!origin || process.env[name] !== origin.value) return undefined;
  return { source: origin.source, file: origin.file };
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Opt-in env var that lets a project `.env` set `*_BASE_URL` overrides and
 * other settings that decide where a key is sent.
 */
export const ALLOW_PROJECT_BASE_URL_ENV = "MULTIX_ALLOW_PROJECT_BASE_URL";

/** True when the opt-in is set in the shell or the user-level env file (never a project file). */
export function projectBaseUrlAllowed(): boolean {
  if (!isTruthy(process.env[ALLOW_PROJECT_BASE_URL_ENV])) return false;
  return envFileOrigin(ALLOW_PROJECT_BASE_URL_ENV)?.source !== "project";
}

const OPT_IN_HINT = `To use the project value for one command, run it as \`${ALLOW_PROJECT_BASE_URL_ENV}=1 multix ...\`. Do not put ${ALLOW_PROJECT_BASE_URL_ENV} in ~/.multix/.env: that trusts the .env of every directory you run multix in.`;

/**
 * One credential a request sends. An array lists alternatives in the order the
 * provider reads them; the first non-blank one is the credential sent.
 */
export type CredentialSpec = string | readonly string[];

/**
 * Why a project env file value is used: the opt-in is set, the value equals
 * the vendor default, or every key sent with it comes from that same file.
 */
export type ProjectTrustBasis = "opt-in" | "default" | "same-file";

/** Effective state of a setting that decides where a key is sent. */
export type TrustedSettingState =
  | { status: "unset" }
  /** The value is used (shell, ~/.multix/.env, or a project file on a ProjectTrustBasis). */
  | {
      status: "used";
      value: string;
      source: EnvFileSource | "shell";
      /** Set only when `source` is "project". */
      basis?: ProjectTrustBasis;
    }
  /** The project value is ignored and the ~/.multix/.env value is used instead. */
  | { status: "fallback"; value: string; file: string; reason: string }
  /** The project value is ignored and there is nothing to fall back to. */
  | { status: "refused"; file: string; reason: string };

function describeSource(origin: { source: EnvFileSource; file: string } | undefined): string {
  if (!origin) return "the shell";
  if (origin.source === "user") return "~/.multix/.env";
  if (origin.source === "legacy") return origin.file;
  return `another project file (${origin.file})`;
}

/**
 * Why sending the `credentials` to an endpoint chosen by `file` could leak a
 * key the project does not own, or undefined when every credential that will
 * be sent comes from that same project file (or none is set).
 */
function foreignCredential(
  credentials: readonly CredentialSpec[],
  file: string,
): string | undefined {
  for (const spec of credentials) {
    const names = typeof spec === "string" ? [spec] : spec;
    const used = names.find((n) => process.env[n]?.trim());
    if (!used) continue;
    const origin = envFileOrigin(used);
    if (origin?.source === "project" && origin.file === file) continue;
    return `${used} comes from ${describeSource(origin)}`;
  }
  return undefined;
}

/**
 * Effective state of a setting that decides where a key is sent (a base URL,
 * an account or gateway ID). Values are trimmed; blank means unset. Never
 * throws or warns; resolveTrustedSetting acts on the result.
 *
 * A value from a project env file (cwd/.env, or a legacy `.claude` file under
 * cwd) is used when MULTIX_ALLOW_PROJECT_BASE_URL is set in the shell or
 * ~/.multix/.env, when it equals `harmless` (e.g. the vendor default), or when
 * every credential in `credentials` that is set comes from that same file
 * (then the only key that can travel is the project's own). Otherwise the
 * ~/.multix/.env value is used if there is one, else the setting is refused.
 * A blank project value never hides the ~/.multix/.env value.
 */
export function inspectTrustedSetting(
  name: string,
  credentials: readonly CredentialSpec[],
  harmless?: string,
): TrustedSettingState {
  const value = process.env[name]?.trim() || undefined;
  const origin = envFileOrigin(name);
  if (origin?.source !== "project") {
    return value
      ? { status: "used", value, source: origin?.source ?? "shell" }
      : { status: "unset" };
  }
  const userValue = userFileValues[envNameKey(name)]?.trim() || undefined;
  if (value === undefined) {
    return userValue
      ? { status: "fallback", value: userValue, file: origin.file, reason: "it is empty" }
      : { status: "unset" };
  }
  const project = (basis: ProjectTrustBasis): TrustedSettingState => ({
    status: "used",
    value,
    source: "project",
    basis,
  });
  if (value === harmless) return project("default");
  if (projectBaseUrlAllowed()) return project("opt-in");
  const reason = foreignCredential(credentials, origin.file);
  if (!reason) return project("same-file");
  return userValue
    ? { status: "fallback", value: userValue, file: origin.file, reason }
    : { status: "refused", file: origin.file, reason };
}

/** The ConfigError message for a refused setting (variable, file and key source; never the value). */
export function trustedSettingRefusal(
  name: string,
  state: { file: string; reason: string },
): string {
  return `${name} is set in project env file ${state.file}, but ${state.reason}, so the project is not trusted to choose where that key is sent. Set ${name} in your shell or ~/.multix/.env, or keep the key in the same project file. ${OPT_IN_HINT}`;
}

/**
 * Act on an inspectTrustedSetting result the way a command does: an ignored
 * project value prints one warning per variable (variable, file and key
 * source; never the value) and uses the ~/.multix/.env value; a refused value
 * throws a ConfigError so no request is sent to a host the user did not choose.
 */
export function applyTrustedSetting(name: string, state: TrustedSettingState): string | undefined {
  if (state.status === "unset") return undefined;
  if (state.status === "used") return state.value;
  if (state.status === "refused") throw new ConfigError(trustedSettingRefusal(name, state));
  const hint = state.reason === "it is empty" ? "" : ` ${OPT_IN_HINT}`;
  warnOnce(
    `ignored:${name}`,
    `Ignoring ${name} from project env file ${state.file} (${state.reason}); using the value from ~/.multix/.env.${hint}`,
  );
  return state.value;
}

/** inspectTrustedSetting then applyTrustedSetting: read a setting the way a command does. */
export function resolveTrustedSetting(
  name: string,
  credentials: readonly CredentialSpec[],
  harmless?: string,
): string | undefined {
  return applyTrustedSetting(name, inspectTrustedSetting(name, credentials, harmless));
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

/** Hosts that may be reached over plain http:// (local mock servers). */
const LOOPBACK_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why `value` cannot be used as the base URL `name`, or undefined when it is
 * an absolute https:// URL, or http:// to a loopback host.
 */
function baseUrlSchemeError(name: string, value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${name} must be an absolute https:// URL`;
  }
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && LOOPBACK_HTTP_HOSTS.has(url.hostname)) return undefined;
  return `${name} must use https:// (host ${url.hostname || "(none)"}); plain http:// is only allowed for localhost, 127.0.0.1, or [::1]`;
}

/** The raw value of `name` when it only restates `defaultUrl` (safe from any source). */
function defaultHarmless(name: string, defaultUrl: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw && stripSlash(raw) === stripSlash(defaultUrl) ? raw : undefined;
}

/**
 * Where a provider sends its key: the env var that overrides its API root,
 * the default root, and the key env names in the order the provider reads
 * them (the first non-blank one is sent). Each provider exports one of these
 * so its key lookup, its base URL trust check and `multix check` agree.
 */
export interface BaseUrlRouting {
  readonly name: string;
  readonly defaultUrl: string;
  readonly keyEnvs: readonly [string, ...string[]];
}

/** inspectTrustedSetting for a base URL, plus the https rule the command applies. */
export type BaseUrlState = TrustedSettingState & {
  /** Set when the value in effect would be rejected by the https rule. */
  schemeError?: string;
};

/**
 * Effective state of a provider base URL. A value equal to `defaultUrl` is
 * always fine; any other value in effect must pass the https rule.
 */
export function inspectBaseUrl(
  name: string,
  defaultUrl: string,
  credentials: readonly CredentialSpec[],
): BaseUrlState {
  const state = inspectTrustedSetting(name, credentials, defaultHarmless(name, defaultUrl));
  if (state.status !== "used" && state.status !== "fallback") return state;
  if (stripSlash(state.value) === stripSlash(defaultUrl)) return state;
  const schemeError = baseUrlSchemeError(name, state.value);
  return schemeError ? { ...state, schemeError } : state;
}

/** inspectBaseUrl for a provider's BaseUrlRouting. */
export function inspectProviderBaseUrl(routing: BaseUrlRouting): BaseUrlState {
  return inspectBaseUrl(routing.name, routing.defaultUrl, [routing.keyEnvs]);
}

/**
 * Resolve a provider API root from `name` (e.g. `HEYGEN_BASE_URL`), falling
 * back to `defaultUrl`.
 *
 * `credentials` are the keys the provider sends to that root (see
 * CredentialSpec). Project env file values follow applyTrustedSetting. A
 * non-default base URL must be https://, except http:// to localhost,
 * 127.0.0.1 or [::1], and one warning per variable names the provider and the
 * hostname only, so a redirected API key is never silent.
 */
export function resolveBaseUrl(
  name: string,
  defaultUrl: string,
  credentials: readonly CredentialSpec[],
): string {
  const state = inspectBaseUrl(name, defaultUrl, credentials);
  const value = applyTrustedSetting(name, state);
  if (!value || stripSlash(value) === stripSlash(defaultUrl)) return defaultUrl;
  if (state.schemeError) throw new ConfigError(state.schemeError);
  const provider = name.replace(/_BASE_URL$/, "");
  warnOnce(
    `custom:${name}`,
    `${name} is set: ${provider} API requests, including your API key, go to ${hostOf(value)} instead of the default host.`,
  );
  return value;
}

/** resolveBaseUrl for a provider's BaseUrlRouting. */
export function resolveProviderBaseUrl(routing: BaseUrlRouting): string {
  return resolveBaseUrl(routing.name, routing.defaultUrl, [routing.keyEnvs]);
}

/** The key a provider sends: the first non-blank of its `keyEnvs`, trimmed. */
export function resolveRoutedKey(routing: BaseUrlRouting): string | undefined {
  return resolveFirstKey(...routing.keyEnvs)?.value;
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
