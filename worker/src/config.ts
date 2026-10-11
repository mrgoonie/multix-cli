/**
 * Worker bindings and server limits.
 *
 * Secrets (MCP_AUTH_TOKEN and provider keys) come from `wrangler secret put`
 * (or `.dev.vars` locally) and are never returned to clients. Plain settings
 * may be set as `vars` in wrangler.jsonc.
 */

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** Bearer token MCP clients must send. Required: the server refuses /mcp without it. */
  MCP_AUTH_TOKEN?: string;

  REPLICATE_API_TOKEN?: string;
  /** Fallback name accepted by the CLI too. */
  REPLICATE_API_KEY?: string;
  ATLASCLOUD_API_KEY?: string;
  HEYGEN_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_AI_GATEWAY_ID?: string;

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

  /** Optional Workers Rate Limiting binding applied to /mcp. */
  MCP_RATE_LIMITER?: RateLimiter;
}

/** Shortest accepted MCP_AUTH_TOKEN; shorter values are treated as unset (fail closed). */
export const MIN_AUTH_TOKEN_LENGTH = 32;
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
    env.MCP_AUTH_TOKEN,
    env.REPLICATE_API_TOKEN,
    env.REPLICATE_API_KEY,
    env.ATLASCLOUD_API_KEY,
    env.HEYGEN_API_KEY,
    env.CLOUDFLARE_API_TOKEN,
  ]
    .map((v) => v?.trim())
    .filter((v): v is string => typeof v === "string" && v.length >= 8);
}
