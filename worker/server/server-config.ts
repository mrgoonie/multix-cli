/**
 * Process configuration of the standalone server, read from the environment.
 * Server-only settings are parsed here; Worker settings (MULTIX_PUBLIC_URL,
 * SESSION_SECRET, SECRETS_ENCRYPTION_KEY, GITHUB_*, MULTIX_LOCAL_AUTH,
 * MULTIX_MCP_*, …) are copied into the Worker env unchanged by `workerVars`.
 */

import { join } from "node:path";
import { maxConcurrentFromEnv } from "../container/local-executor.mjs";

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  /** X-Forwarded-For entries appended by trusted reverse proxies (0: use the socket peer). */
  trustProxyHops: number;
  maxBodyBytes: number;
  shutdownTimeoutMs: number;
  mcpRateLimit: number;
  authRateLimit: number;
  /** MULTIX_LOCAL_JOBS=true: run jobs as child processes (needs the multix CLI). */
  localJobs: boolean;
  /** Job records and the executor lock: `<dataDir>/jobs`. */
  jobsStateDir: string;
  /** MULTIX_LOCAL_MAX_CONCURRENT_JOBS, 1 to 64 (default 1). */
  maxConcurrentJobs: number;
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw || raw === "false" || raw === "0") return false;
  if (raw === "true" || raw === "1") return true;
  throw new Error(`${name} must be true or false`);
}

function int(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function serverConfigFrom(env: NodeJS.ProcessEnv): ServerConfig {
  const dataDir = env.MULTIX_DATA_DIR?.trim() || "/data";
  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port: int(env, "PORT", 3000, 1, 65535),
    dataDir,
    databasePath: join(dataDir, "multix.sqlite"),
    trustProxyHops: int(env, "MULTIX_TRUST_PROXY_HOPS", 0, 0, 10),
    maxBodyBytes: int(env, "MULTIX_MAX_BODY_BYTES", 16 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
    shutdownTimeoutMs: int(env, "MULTIX_SHUTDOWN_TIMEOUT_MS", 20_000, 0, 300_000),
    mcpRateLimit: int(env, "MULTIX_MCP_RATE_LIMIT", 60, 1, 100_000),
    authRateLimit: int(env, "MULTIX_AUTH_RATE_LIMIT", 30, 1, 100_000),
    localJobs: flag(env, "MULTIX_LOCAL_JOBS"),
    jobsStateDir: join(dataDir, "jobs"),
    maxConcurrentJobs: maxConcurrentFromEnv(env),
  };
}

/** Worker secrets and vars: GitHub OAuth, session, encryption, bootstrap, and every MULTIX_* setting. */
const WORKER_NAMES = new Set([
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "SESSION_SECRET",
  "SECRETS_ENCRYPTION_KEY",
]);

/** Server-only settings that are not Worker vars. */
const SERVER_ONLY = new Set([
  "MULTIX_DATA_DIR",
  "MULTIX_TRUST_PROXY_HOPS",
  "MULTIX_MAX_BODY_BYTES",
  "MULTIX_SHUTDOWN_TIMEOUT_MS",
  "MULTIX_MCP_RATE_LIMIT",
  "MULTIX_AUTH_RATE_LIMIT",
  "MULTIX_LOCAL_JOBS",
  "MULTIX_LOCAL_MAX_CONCURRENT_JOBS",
]);

/**
 * The string vars passed to the Worker. Provider keys are never read from the
 * process environment: each account saves its own in the dashboard.
 */
export function workerVars(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (WORKER_NAMES.has(name) || (name.startsWith("MULTIX_") && !SERVER_ONLY.has(name))) {
      out[name] = value;
    }
  }
  return out;
}
