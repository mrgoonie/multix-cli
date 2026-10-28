/**
 * TopView routing, task kinds, status normalization and input checks.
 * Runtime-neutral: no node:* imports and no env access.
 *
 * TopView has two unrelated API surfaces under one account, with separate
 * keys and balances and no credit transfer between them:
 * - Legacy API (https://api.topview.ai): marketing features billed in
 *   credits, authenticated with `Authorization: Bearer <key>` plus
 *   `Topview-Uid: <uid>`. Reference: https://docs.topview.ai/llms.txt
 * - API Platform (https://platform-backend.topview.ai/api/v1): generic model
 *   predictions billed in USD. Reference: https://platform.topview.ai/llms.txt
 *
 * The marketing page https://www.topview.ai/openapi advertises
 * /v1/url2video/task/submit, /v1/materials2video/task/submit,
 * /v1/product_avatar/task/submit and /v1/product_anyshoot/task/submit. None of
 * them appears in the API reference above, and their sample bodies contradict
 * it, so this provider uses the documented endpoints instead:
 * - URL/materials to video (POST /v1/m2v/task/submit):
 *   https://docs.topview.ai/reference/avatar_marketing_video_submit_task
 * - Product avatar (remove background, then V3 image_replace and image2Video):
 *   https://docs.topview.ai/reference/pa3_getting_started
 * - Product anyshoot (POST /v1/product_anyShoot/task/submit):
 *   https://docs.topview.ai/reference/product_anyshoot_v1
 */

import { ProviderError, ValidationError } from "../../core/errors.js";
import { checkUrlSafety } from "../../core/url-safety.js";

export const DEFAULT_TOPVIEW_BASE_URL = "https://api.topview.ai";
export const DEFAULT_TOPVIEW_PLATFORM_BASE_URL = "https://platform-backend.topview.ai/api/v1";

/** Legacy API (credits): base URL override and key env name. */
export const TOPVIEW_ROUTING = {
  name: "TOPVIEW_BASE_URL",
  defaultUrl: "https://api.topview.ai",
  keyEnvs: ["TOPVIEW_API_KEY"],
} as const;

/** API Platform (USD): base URL override and key env name. */
export const TOPVIEW_PLATFORM_ROUTING = {
  name: "TOPVIEW_PLATFORM_BASE_URL",
  defaultUrl: "https://platform-backend.topview.ai/api/v1",
  keyEnvs: ["TOPVIEW_PLATFORM_API_KEY"],
} as const;

/** The legacy API also needs the account UID in a `Topview-Uid` header. */
export const TOPVIEW_UID_ENV = "TOPVIEW_UID";

/** Legacy API key and UID: topview.ai, avatar menu, API Settings, API tab. */
export const TOPVIEW_DASHBOARD_LINK = "https://www.topview.ai/openapi";
/** API Platform keys, balance, billing and usage. */
export const TOPVIEW_PLATFORM_DASHBOARD_LINK = "https://platform.topview.ai";
export const TOPVIEW_DOCS_LINK = "https://docs.topview.ai";
export const TOPVIEW_PLATFORM_DOCS_LINK = "https://platform.topview.ai/llms.txt";
export const TOPVIEW_PLATFORM_PRICING_LINK = "https://platform.topview.ai/pricing";

/** Legacy task kinds; each has its own submit and query endpoint. */
export const LEGACY_KINDS = [
  "m2v",
  "video-avatar",
  "remove-background",
  "product-avatar-replace",
  "product-avatar-video",
  "product-anyshoot",
] as const;
export type LegacyKind = (typeof LEGACY_KINDS)[number];

/** Kinds accepted by `topview status`; url-to-video and materials-to-video are m2v tasks. */
export const STATUS_KINDS = [
  "url-to-video",
  "materials-to-video",
  ...LEGACY_KINDS,
  "platform",
] as const;
export type StatusKind = (typeof STATUS_KINDS)[number];

export function parseStatusKind(raw: string): LegacyKind | "platform" {
  const kind = raw.trim().toLowerCase();
  if (kind === "url-to-video" || kind === "materials-to-video") return "m2v";
  if ((LEGACY_KINDS as readonly string[]).includes(kind)) return kind as LegacyKind;
  if (kind === "platform") return "platform";
  throw new ValidationError(`Unknown task kind "${raw}". Use one of: ${STATUS_KINDS.join(", ")}`);
}

/** Normalized legacy task status. Unknown values are kept as-is and treated as non-terminal. */
export type LegacyStatus = "init" | "running" | "success" | "fail";

const STATUS_SYNONYMS: Record<string, LegacyStatus> = {
  init: "init",
  pending: "init",
  queued: "init",
  waiting: "init",
  created: "init",
  running: "running",
  processing: "running",
  in_progress: "running",
  generating: "running",
  success: "success",
  succeeded: "success",
  succeed: "success",
  completed: "success",
  complete: "success",
  finished: "success",
  done: "success",
  fail: "fail",
  failed: "fail",
  failure: "fail",
  error: "fail",
  cancelled: "fail",
  canceled: "fail",
};

/** Map a raw legacy status leniently; empty or unknown values come back as the raw string. */
export function normalizeLegacyStatus(raw: unknown): LegacyStatus | string {
  if (typeof raw !== "string" || raw.trim() === "") return "unknown";
  return STATUS_SYNONYMS[raw.trim().toLowerCase()] ?? raw.trim().toLowerCase();
}

export function isLegacyTerminal(status: string): boolean {
  return status === "success" || status === "fail";
}

/** Legacy task ids and fileIds: opaque tokens, safe to put in a query string. */
const LEGACY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isLegacyId(value: unknown): value is string {
  return typeof value === "string" && LEGACY_ID_RE.test(value);
}

export function assertLegacyId(value: string, what = "task id"): string {
  const id = value.trim();
  if (!isLegacyId(id)) {
    throw new ValidationError(`Invalid TopView ${what}: expected letters, digits, "_" or "-"`);
  }
  return id;
}

/** Platform prediction ids are alphanumeric in the docs; allow "_" and "-" defensively. */
const PREDICTION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isPredictionId(value: unknown): value is string {
  return typeof value === "string" && PREDICTION_ID_RE.test(value);
}

export function assertPredictionId(value: string): string {
  const id = value.trim();
  if (!isPredictionId(id)) {
    throw new ValidationError("Invalid TopView prediction id: expected letters and digits");
  }
  return id;
}

export const URL_MAX_LENGTH = 4096;

/**
 * A URL that TopView will fetch on the caller's behalf (product page, image or
 * video input): http(s) only, no credentials, and never a local or private
 * address. The address check is the shared download policy, applied to an
 * https copy so a plain http:// product page is still accepted.
 */
export function assertPublicHttpUrl(value: string, flag: string): string {
  const trimmed = value.trim();
  if (trimmed.length > URL_MAX_LENGTH) {
    throw new ValidationError(`${flag} URL is longer than ${URL_MAX_LENGTH} characters`);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ValidationError(`${flag} is not a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ValidationError(`${flag} must be an http:// or https:// URL`);
  }
  if (url.username || url.password) {
    throw new ValidationError(`${flag} URL must not contain a username or password`);
  }
  const httpsCopy = new URL(url.href);
  httpsCopy.protocol = "https:";
  try {
    checkUrlSafety(httpsCopy.href, { provider: "topview", action: "send" });
  } catch (error) {
    if (error instanceof ProviderError) {
      throw new ValidationError(
        `${flag} must point to a public address, not a local or private one (${url.hostname})`,
      );
    }
    throw error;
  }
  return trimmed;
}

/** Legacy upload formats (https://docs.topview.ai, "Upload file"). */
export const UPLOAD_FORMATS = {
  image: ["png", "jpg", "jpeg", "bmp", "webp"],
  audio: ["mp3", "wav", "m4a"],
  video: ["mp4", "avi", "mov"],
} as const;

export function uploadFormatOf(ext: string): string | undefined {
  const format = ext.replace(/^\./, "").toLowerCase();
  const all: readonly string[] = [
    ...UPLOAD_FORMATS.image,
    ...UPLOAD_FORMATS.audio,
    ...UPLOAD_FORMATS.video,
  ];
  return all.includes(format) ? format : undefined;
}
