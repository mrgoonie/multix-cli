/**
 * Worker bindings and server limits.
 *
 * Two shapes live here:
 * - `WorkerEnv`: what Cloudflare binds to the Worker (KV namespaces, Worker
 *   secrets from `wrangler secret put`, plain `vars` from wrangler.jsonc).
 * - `Env`: the per-request tool configuration. Provider keys in it belong to
 *   the signed-in account (decrypted from ACCOUNTS_KV); the operator's
 *   `MULTIX_MCP_*` limits are copied in from `WorkerEnv`.
 */

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Operator-wide tool limits, set as `vars` in wrangler.jsonc. */
export interface ServerSettings {
  /** Comma-separated provider allowlist. Unset = every configured provider. */
  MULTIX_MCP_ALLOWED_PROVIDERS?: string;
  /** Comma-separated `provider:model` allowlist. Unset = any model. */
  MULTIX_MCP_ALLOWED_MODELS?: string;
  /** Max images per generate_image call (default 4, hard cap 10). */
  MULTIX_MCP_MAX_OUTPUTS?: string;
  /** Max video duration in seconds (default 10, hard cap 15). */
  MULTIX_MCP_MAX_VIDEO_SECONDS?: string;
  /** Comma-separated video resolutions callers may request (default 480p,720p,768p,1080p). */
  MULTIX_MCP_ALLOWED_RESOLUTIONS?: string;
  /** Comma-separated browser origins allowed to call /mcp. Requests with other Origins get 403. */
  MULTIX_MCP_ALLOWED_ORIGINS?: string;
}

/** Provider credentials an account can store from the dashboard. */
export const PROVIDER_SECRET_NAMES = [
  "REPLICATE_API_TOKEN",
  "ATLASCLOUD_API_KEY",
  "HEYGEN_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_AI_GATEWAY_ID",
] as const;
export type ProviderSecretName = (typeof PROVIDER_SECRET_NAMES)[number];

export type ProviderKeys = Partial<Record<ProviderSecretName, string>>;

/** Per-request tool configuration: operator limits plus the caller's own provider keys. */
export interface Env extends ServerSettings, ProviderKeys {
  /** Fallback name for REPLICATE_API_TOKEN accepted by the shared Replicate client. */
  REPLICATE_API_KEY?: string;
}

/** Cloudflare bindings, Worker secrets and vars. */
export interface WorkerEnv extends ServerSettings {
  /** OAuth grants, tokens and registered clients (managed by workers-oauth-provider). */
  OAUTH_KV: KVNamespace;
  /** Accounts and their encrypted provider keys. */
  ACCOUNTS_KV: KVNamespace;
  /** Set by OAuthProvider before the default handler runs. */
  OAUTH_PROVIDER?: OAuthHelpers;

  /** Public origin, e.g. https://multix.zuey.me. The MCP resource is `${origin}/mcp`. */
  MULTIX_PUBLIC_URL?: string;
  /** Comma-separated GitHub logins and/or verified emails allowed to sign in. Empty = nobody. */
  MULTIX_ALLOWED_USERS?: string;

  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** HMAC key (32+ chars) for dashboard session and sign-in cookies. */
  SESSION_SECRET?: string;
  /** Base64 of 32 random bytes: AES-256-GCM key for stored provider keys. */
  SECRETS_ENCRYPTION_KEY?: string;

  /** Optional Workers Rate Limiting binding applied per account to /mcp. */
  MCP_RATE_LIMITER?: RateLimiter;
  /** Optional Workers Rate Limiting binding applied per IP to sign-in and dashboard writes. */
  AUTH_RATE_LIMITER?: RateLimiter;
}

/** Copy only the operator limits out of the Worker env (never Worker secrets). */
export function serverSettings(env: ServerSettings): ServerSettings {
  return {
    MULTIX_MCP_ALLOWED_PROVIDERS: env.MULTIX_MCP_ALLOWED_PROVIDERS,
    MULTIX_MCP_ALLOWED_MODELS: env.MULTIX_MCP_ALLOWED_MODELS,
    MULTIX_MCP_MAX_OUTPUTS: env.MULTIX_MCP_MAX_OUTPUTS,
    MULTIX_MCP_MAX_VIDEO_SECONDS: env.MULTIX_MCP_MAX_VIDEO_SECONDS,
    MULTIX_MCP_ALLOWED_RESOLUTIONS: env.MULTIX_MCP_ALLOWED_RESOLUTIONS,
    MULTIX_MCP_ALLOWED_ORIGINS: env.MULTIX_MCP_ALLOWED_ORIGINS,
  };
}

/** Shortest accepted SESSION_SECRET; shorter values are treated as unset (fail closed). */
export const MIN_SESSION_SECRET_LENGTH = 32;
/** Max JSON-RPC request body. Tool inputs are small; media is passed by URL. */
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_PROMPT_CHARS = 4000;
export const MAX_URL_CHARS = 2048;
/** Longest an image call waits for a result before returning a prediction id. */
export const MAX_IMAGE_WAIT_SECONDS = 25;
export const DEFAULT_IMAGE_WAIT_SECONDS = 20;

const OUTPUTS_DEFAULT = 4;
const OUTPUTS_CEILING = 10;
const VIDEO_SECONDS_DEFAULT = 10;
const VIDEO_SECONDS_CEILING = 15;
/** Duration sent when the caller omits one, so a provider default can never exceed the cap. */
const VIDEO_SECONDS_WHEN_OMITTED = 5;
/** 768p is a HeyGen Video resolution between 720p and 1080p. */
const RESOLUTIONS_DEFAULT = ["480p", "720p", "768p", "1080p"];

export function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function boundedInt(raw: string | undefined, fallback: number, ceiling: number): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, ceiling);
}

export interface Limits {
  maxOutputs: number;
  maxVideoSeconds: number;
  /** Duration used when the caller omits one: min(5, maxVideoSeconds). */
  defaultVideoSeconds: number;
  /** Lower-case resolutions callers may request. */
  allowedResolutions: string[];
}

export function limitsFrom(env: Env): Limits {
  const maxVideoSeconds = boundedInt(
    env.MULTIX_MCP_MAX_VIDEO_SECONDS,
    VIDEO_SECONDS_DEFAULT,
    VIDEO_SECONDS_CEILING,
  );
  const resolutions = csv(env.MULTIX_MCP_ALLOWED_RESOLUTIONS).map((r) => r.toLowerCase());
  return {
    maxOutputs: boundedInt(env.MULTIX_MCP_MAX_OUTPUTS, OUTPUTS_DEFAULT, OUTPUTS_CEILING),
    maxVideoSeconds,
    defaultVideoSeconds: Math.min(VIDEO_SECONDS_WHEN_OMITTED, maxVideoSeconds),
    allowedResolutions: resolutions.length > 0 ? resolutions : RESOLUTIONS_DEFAULT,
  };
}

/** Every secret value configured on the Worker, for scrubbing error text. */
export function secretValues(env: Env): string[] {
  return [
    env.REPLICATE_API_TOKEN,
    env.REPLICATE_API_KEY,
    env.ATLASCLOUD_API_KEY,
    env.HEYGEN_API_KEY,
    env.CLOUDFLARE_API_TOKEN,
  ]
    .map((v) => v?.trim())
    .filter((v): v is string => typeof v === "string" && v.length >= 8);
}
