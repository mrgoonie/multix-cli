/**
 * Replicate model identifiers, defaults, and status helpers.
 * Runtime-neutral: no node:* imports and no env access — callers resolve env
 * overrides (REPLICATE_IMAGE_MODEL / REPLICATE_VIDEO_MODEL) themselves.
 *
 * Defaults are official Replicate models (`is_official: true` on
 * GET /v1/models/{owner}/{name}), so they run on the model endpoint without a
 * pinned version and stay current:
 * - black-forest-labs/flux-schnell — fast, low-cost text-to-image.
 * - prunaai/p-video — text-to-video and image-to-video (`image` input), with a
 *   low-cost `draft` mode.
 */

import { ValidationError } from "../../core/errors.js";
import type { ModelRef, ReplicateStatus } from "./types.js";

export const DEFAULT_REPLICATE_BASE_URL = "https://api.replicate.com/v1";
export const DEFAULT_REPLICATE_IMAGE_MODEL = "black-forest-labs/flux-schnell";
export const DEFAULT_REPLICATE_VIDEO_MODEL = "prunaai/p-video";

export const TERMINAL_STATUSES: readonly ReplicateStatus[] = [
  "succeeded",
  "failed",
  "canceled",
  "aborted",
];

export function isTerminalStatus(status: string | undefined): boolean {
  return TERMINAL_STATUSES.includes(status as ReplicateStatus);
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const VERSION_RE = /^[a-z0-9]+$/i;
const BARE_VERSION_RE = /^[a-f0-9]{64}$/i;

/**
 * Parse a model reference:
 * - `owner/name` → official model endpoint (unless `explicitVersion` is given)
 * - `owner/name:version` → versioned prediction
 * - a bare 64-char version id → versioned prediction
 */
export function parseModelRef(ref: string, explicitVersion?: string): ModelRef {
  const trimmed = ref.trim();
  if (explicitVersion !== undefined && !VERSION_RE.test(explicitVersion)) {
    throw new ValidationError(`Invalid Replicate version id "${explicitVersion}"`);
  }

  if (BARE_VERSION_RE.test(trimmed)) {
    if (explicitVersion && explicitVersion !== trimmed) {
      throw new ValidationError("Conflicting version ids: model argument and --version differ");
    }
    return { kind: "version", version: trimmed };
  }

  const [path, inlineVersion, ...rest] = trimmed.split(":");
  const [owner, name, ...extra] = (path ?? "").split("/");
  if (rest.length > 0 || extra.length > 0 || !owner || !name) {
    throw new ValidationError(
      `Invalid Replicate model "${ref}" — expected owner/name, owner/name:version, or a 64-char version id`,
    );
  }
  if (!NAME_RE.test(owner) || !NAME_RE.test(name)) {
    throw new ValidationError(`Invalid Replicate model "${ref}" — owner and name must be slugs`);
  }
  if (inlineVersion !== undefined) {
    if (!VERSION_RE.test(inlineVersion)) {
      throw new ValidationError(`Invalid Replicate version id in "${ref}"`);
    }
    if (explicitVersion && explicitVersion !== inlineVersion) {
      throw new ValidationError("Conflicting version ids: model argument and --version differ");
    }
    return { kind: "version", version: inlineVersion, owner, name };
  }
  if (explicitVersion) return { kind: "version", version: explicitVersion, owner, name };
  return { kind: "official", owner, name };
}

/** Human-readable label for logs. */
export function describeModelRef(ref: ModelRef): string {
  if (ref.kind === "official") return `${ref.owner}/${ref.name}`;
  const short = ref.version.slice(0, 12);
  return ref.owner && ref.name ? `${ref.owner}/${ref.name}:${short}` : `version ${short}`;
}

const PREDICTION_ID_RE = /^[a-z0-9]+$/i;

/** Prediction ids are opaque alphanumerics; reject anything that could alter the URL path. */
export function assertPredictionId(id: string): string {
  const trimmed = id.trim();
  if (!PREDICTION_ID_RE.test(trimmed)) {
    throw new ValidationError(`Invalid Replicate prediction id "${id}"`);
  }
  return trimmed;
}
