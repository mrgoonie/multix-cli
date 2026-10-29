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
import type { AccountEventsNamespace } from "./events/account-events.js";
import {
  type JobCaps,
  type JobQuotaNamespace,
  MAX_ACTIVE_JOBS_PER_ACCOUNT,
  MAX_ACTIVE_JOBS_TOTAL,
} from "./jobs/account-job-quota.js";
import type { JobNamespace } from "./jobs/job-store.js";
import {
  NON_SECRET_NAMES,
  PROVIDER_SECRET_NAMES,
  type ProviderKeys,
} from "./provider-secret-names.js";
import type { AccountSkillsNamespace } from "./skills/account-skills.js";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Operator-wide tool limits, set as `vars` in wrangler.jsonc. */
export interface ServerSettings {
  /** Max images per multix_run call (default 4, hard cap 10). */
  MULTIX_MCP_MAX_OUTPUTS?: string;
  /** Max video duration in seconds (default 10, hard cap 15). */
  MULTIX_MCP_MAX_VIDEO_SECONDS?: string;
  /** Max generated audio length in seconds (default 30, hard cap 300). */
  MULTIX_MCP_MAX_AUDIO_SECONDS?: string;
  /** Comma-separated video resolutions callers may request (default 480p,720p,768p,1080p). */
  MULTIX_MCP_ALLOWED_RESOLUTIONS?: string;
  /**
   * Comma-separated `<group>:<model>` entries the image commands of
   * multix_run may use (default: any model), e.g. `fal:fal-ai/flux/schnell`.
   * The model sets the price of each image.
   */
  MULTIX_MCP_ALLOWED_IMAGE_MODELS?: string;
  /** Comma-separated browser origins allowed to call /mcp. Requests with other Origins get 403. */
  MULTIX_MCP_ALLOWED_ORIGINS?: string;
  /**
   * Runs the caps above cannot bound (pass-through `run` bodies, spend set by
   * the length of the source media): `budget` (default) runs one only with a
   * max_cost_usd its price estimate proves, `deny` refuses it, `allow` runs it.
   */
  MULTIX_MCP_UNCAPPED_SPEND?: string;
}

export {
  PROVIDER_SECRET_NAMES,
  type ProviderKeys,
  type ProviderSecretName,
} from "./provider-secret-names.js";

/** Per-request tool configuration: operator limits plus the caller's own provider keys. */
export interface Env extends ServerSettings, ProviderKeys {}

/** Cloudflare bindings, Worker secrets and vars. */
export interface WorkerEnv extends ServerSettings {
  /** OAuth grants, tokens and registered clients (managed by workers-oauth-provider). */
  OAUTH_KV: KVNamespace;
  /** Accounts, their encrypted provider keys and R2 settings. */
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
  /** Durable Object namespace of MultixJobContainer (one container per multix_run job). */
  MULTIX_JOBS?: JobNamespace;
  /** Durable Object namespace of AccountJobQuota (active job slots per account and server-wide). */
  MULTIX_JOB_QUOTA?: JobQuotaNamespace;
  /** Durable Object namespace of AccountEvents (event subscriptions and webhook deliveries per account). */
  MULTIX_EVENTS?: AccountEventsNamespace;
  /** Durable Object namespace of AccountSkills (each account's versioned skills registry). */
  MULTIX_SKILLS?: AccountSkillsNamespace;
  /** Jobs one account may run at the same time (default 2, at most 50). */
  MULTIX_MAX_JOBS_PER_ACCOUNT?: string;
  /** Jobs the server may run at the same time (default 10, at most 1000; keep <= containers max_instances). */
  MULTIX_MAX_JOBS_TOTAL?: string;
}

/** Copy only the operator limits out of the Worker env (never Worker secrets). */
export function serverSettings(env: ServerSettings): ServerSettings {
  return {
    MULTIX_MCP_MAX_OUTPUTS: env.MULTIX_MCP_MAX_OUTPUTS,
    MULTIX_MCP_MAX_VIDEO_SECONDS: env.MULTIX_MCP_MAX_VIDEO_SECONDS,
    MULTIX_MCP_MAX_AUDIO_SECONDS: env.MULTIX_MCP_MAX_AUDIO_SECONDS,
    MULTIX_MCP_ALLOWED_RESOLUTIONS: env.MULTIX_MCP_ALLOWED_RESOLUTIONS,
    MULTIX_MCP_ALLOWED_IMAGE_MODELS: env.MULTIX_MCP_ALLOWED_IMAGE_MODELS,
    MULTIX_MCP_ALLOWED_ORIGINS: env.MULTIX_MCP_ALLOWED_ORIGINS,
    MULTIX_MCP_UNCAPPED_SPEND: env.MULTIX_MCP_UNCAPPED_SPEND,
  };
}

/** Shortest accepted SESSION_SECRET; shorter values are treated as unset (fail closed). */
export const MIN_SESSION_SECRET_LENGTH = 32;
/** Max JSON-RPC request body. Tool inputs are small; media is passed by URL. */
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_URL_CHARS = 2048;

const OUTPUTS_DEFAULT = 4;
const OUTPUTS_CEILING = 10;
const VIDEO_SECONDS_DEFAULT = 10;
const VIDEO_SECONDS_CEILING = 15;
/** Duration sent when the caller omits one, so a provider default can never exceed the cap. */
const VIDEO_SECONDS_WHEN_OMITTED = 5;
/** ElevenLabs' longest sound effect. */
const AUDIO_SECONDS_DEFAULT = 30;
/** Half of ElevenLabs Music's 10-minute maximum. */
const AUDIO_SECONDS_CEILING = 300;
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
  /** Generated audio length in seconds (sound effects, music). */
  maxAudioSeconds: number;
  /** Lower-case resolutions callers may request. */
  allowedResolutions: string[];
  /** `<group>:<model>` entries image commands may use; empty means any model. */
  allowedImageModels: string[];
  /** What a run the caps cannot bound needs (see MULTIX_MCP_UNCAPPED_SPEND). */
  uncappedSpend: UncappedSpendMode;
}

export type UncappedSpendMode = "budget" | "deny" | "allow";
const UNCAPPED_SPEND_MODES: readonly UncappedSpendMode[] = ["budget", "deny", "allow"];

/** An unknown value falls back to `budget`, so a typo never opens the guard. */
function uncappedSpendMode(raw: string | undefined): UncappedSpendMode {
  const mode = raw?.trim().toLowerCase();
  return UNCAPPED_SPEND_MODES.find((m) => m === mode) ?? "budget";
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
    maxAudioSeconds: boundedInt(
      env.MULTIX_MCP_MAX_AUDIO_SECONDS,
      AUDIO_SECONDS_DEFAULT,
      AUDIO_SECONDS_CEILING,
    ),
    allowedResolutions: resolutions.length > 0 ? resolutions : RESOLUTIONS_DEFAULT,
    allowedImageModels: csv(env.MULTIX_MCP_ALLOWED_IMAGE_MODELS),
    uncappedSpend: uncappedSpendMode(env.MULTIX_MCP_UNCAPPED_SPEND),
  };
}

/** Every provider key value in the tool env, for scrubbing error text. */
export function secretValues(env: Env): string[] {
  return PROVIDER_SECRET_NAMES.filter((name) => !NON_SECRET_NAMES.has(name))
    .map((name) => env[name]?.trim())
    .filter((v): v is string => typeof v === "string" && v.length >= 8);
}

const JOBS_PER_ACCOUNT_CEILING = 50;
const JOBS_TOTAL_CEILING = 1000;

/** Concurrent job caps from the Worker vars; invalid or missing values use the defaults. */
export function jobCapsFrom(env: WorkerEnv): JobCaps {
  return {
    perAccount: boundedInt(
      env.MULTIX_MAX_JOBS_PER_ACCOUNT,
      MAX_ACTIVE_JOBS_PER_ACCOUNT,
      JOBS_PER_ACCOUNT_CEILING,
    ),
    total: boundedInt(env.MULTIX_MAX_JOBS_TOTAL, MAX_ACTIVE_JOBS_TOTAL, JOBS_TOTAL_CEILING),
  };
}
