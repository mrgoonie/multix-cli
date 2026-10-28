/**
 * Sume API (https://api.sume.com) routing, ids and small helpers.
 * Runtime-neutral: no node:* imports and no env access, so the client and the
 * pre-flight quote can also run in a Cloudflare Worker.
 *
 * Sume routes many vendors' image and video models behind one API. The model
 * list is not hard-coded: `GET /v1/open/catalog` (public, keyless) is the
 * source of truth, and commands require an explicit `-m <id>` from it.
 */

import { ValidationError } from "../../core/errors.js";
import type { SumeJobStatus } from "./types.js";

export const DEFAULT_SUME_BASE_URL = "https://api.sume.com";

/**
 * Base URL override and the key env name. Shared by the key lookup, the base
 * URL trust check and `multix check`, so the three cannot drift apart.
 */
export const SUME_ROUTING = {
  name: "SUME_BASE_URL",
  defaultUrl: DEFAULT_SUME_BASE_URL,
  keyEnvs: ["SUME_API_KEY"],
} as const;

/**
 * How to get a key: the authentication guide walks through Dashboard → API
 * keys, top-ups and per-key spend limits (the dashboard itself needs a login).
 */
export const SUME_DASHBOARD_LINK = "https://www.sume.com/docs/authentication";
export const SUME_PRICING_LINK = "https://www.sume.com/pricing/api";

/** Public, keyless model catalogue (ids, modes, capabilities, USD prices). */
export const SUME_CATALOG_URL = `${DEFAULT_SUME_BASE_URL}/v1/open/catalog`;
/** Public, keyless price quote for one request (`{model, input}`). */
export const SUME_ESTIMATE_URL = `${DEFAULT_SUME_BASE_URL}/v1/open/estimate`;

export const TERMINAL_STATUSES: readonly SumeJobStatus[] = ["completed", "failed", "canceled"];

export function isTerminalStatus(status: string | undefined): boolean {
  return TERMINAL_STATUSES.includes(status as SumeJobStatus);
}

/** Sume job ids are `job_<uuid>`. */
const JOB_ID_RE = /^job_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a well-formed job id (safe in URL paths, file names and printed commands). */
export function isValidJobId(id: unknown): id is string {
  return typeof id === "string" && JOB_ID_RE.test(id);
}

/** Reject anything but `job_<uuid>` so a job id can never alter the request path. */
export function assertJobId(id: string): string {
  const trimmed = id.trim();
  if (!JOB_ID_RE.test(trimmed)) {
    throw new ValidationError(`Invalid Sume job id "${id}" — expected job_<uuid>`);
  }
  return `job_${trimmed.slice(4).toLowerCase()}`;
}

/** Sume accepts 1-255 printable ASCII characters (0x20-0x7E) as an Idempotency-Key. */
const IDEMPOTENCY_KEY_RE = /^[\x20-\x7E]{1,255}$/;

export function assertIdempotencyKey(key: string): string {
  if (!IDEMPOTENCY_KEY_RE.test(key) || key.trim() === "") {
    throw new ValidationError(
      "--idempotency-key must be 1-255 printable ASCII characters (letters, digits, punctuation, spaces)",
    );
  }
  return key;
}

/** A fresh idempotency key for one command invocation. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** `$0.79` from a decimal USD string, or undefined when it is not one. */
export function parseUsd(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value.trim())) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** `$1.23` for log lines from whole cents. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
