/**
 * TopView routing, links, enums, ID checks and the verified API Platform
 * route table. Runtime-neutral: no node:* imports and no env access.
 *
 * TopView has two separate APIs under one account, with separate keys and
 * balances that are never pooled ("Balances cannot be shared or
 * transferred", https://www.topview.ai/openapi):
 * - Legacy API: https://api.topview.ai, `Authorization: Bearer <key>` plus
 *   `Topview-Uid: <uid>`, credits shared with the topview.ai web plan.
 *   Only the endpoints in https://docs.topview.ai are used; the paths printed
 *   on the marketing page (/v1/url2video, /v1/materials2video,
 *   /v1/product_avatar/task/submit, /v1/product_anyshoot/task/submit) are not
 *   documented there and are never called.
 * - API Platform: https://platform-backend.topview.ai, `Authorization: Bearer
 *   <platform key>`, a separate USD balance per workspace.
 */

import { ValidationError } from "../../core/errors.js";
import type { LegacyTaskKind } from "./types.js";

export const DEFAULT_TOPVIEW_BASE_URL = "https://api.topview.ai";
export const DEFAULT_TOPVIEW_PLATFORM_BASE_URL = "https://platform-backend.topview.ai";

/**
 * Legacy API base URL override and key env name. TOPVIEW_UID is an account
 * identifier sent in the Topview-Uid header, not a secret.
 */
export const TOPVIEW_ROUTING = {
  name: "TOPVIEW_BASE_URL",
  defaultUrl: DEFAULT_TOPVIEW_BASE_URL,
  keyEnvs: ["TOPVIEW_API_KEY"],
} as const;

/** API Platform base URL override and key env name (separate key and balance). */
export const TOPVIEW_PLATFORM_ROUTING = {
  name: "TOPVIEW_PLATFORM_BASE_URL",
  defaultUrl: DEFAULT_TOPVIEW_PLATFORM_BASE_URL,
  keyEnvs: ["TOPVIEW_PLATFORM_API_KEY"],
} as const;

export const TOPVIEW_UID_ENV = "TOPVIEW_UID";

/** Legacy API key and Topview Uid: account menu, "API Settings". */
export const TOPVIEW_API_SETTINGS_LINK = "https://www.topview.ai/api-settings";
/** Legacy credits are the topview.ai web plan credits. */
export const TOPVIEW_DASHBOARD_LINK = "https://www.topview.ai/dashboard/home";
/** API Platform console: API keys, balance top-up, task history. */
export const TOPVIEW_PLATFORM_CONSOLE_LINK = "https://platform.topview.ai";
export const TOPVIEW_PLATFORM_PRICING_LINK = "https://platform.topview.ai/pricing";
export const TOPVIEW_LEGACY_DOCS_LINK = "https://docs.topview.ai";
export const TOPVIEW_PLATFORM_DOCS_LINK = "https://platform.topview.ai/docs";

/** Public, unauthenticated model and price catalog of the API Platform. */
export const PLATFORM_CATALOG_PATH = "/platform/v1/models";

// ---------------------------------------------------------------------------
// Legacy enums (docs.topview.ai reference pages)
// ---------------------------------------------------------------------------

export const ASPECT_RATIOS = ["9:16", "3:4", "1:1", "4:3", "16:9"] as const;

export const M2V_LANGUAGES = [
  "en",
  "ar",
  "bg",
  "hr",
  "cs",
  "da",
  "nl",
  "fil",
  "fi",
  "fr",
  "de",
  "el",
  "hi",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "ms",
  "nb",
  "pl",
  "pt",
  "ro",
  "ru",
  "zh-CN",
  "sk",
  "es",
  "sv",
  "zh-Hant",
  "tr",
  "uk",
  "vi",
  "th",
] as const;

/** m2v videoLengthType: 1 = 30-50s, 2 = 15-30s, 3 = 30-45s, 4 = 45-60s. */
export const VIDEO_LENGTH_TYPES = ["1", "2", "3", "4"] as const;

/** Product Avatar V3 image2Video modes (all 1080p). */
export const PRODUCT_AVATAR_MODES = ["avatar2", "avatar4", "avatar4Fast"] as const;
export const GENERATE_IMAGE_MODES = ["auto", "manual"] as const;
export const PRODUCT_SIMILARITY = ["natural", "creative"] as const;
/** Video Avatar modeType: 0 = Avatar 1, 1 = Avatar 2. */
export const VIDEO_AVATAR_MODE_TYPES = ["0", "1"] as const;
export const VOICE_SPEED_MIN = 0.8;
export const VOICE_SPEED_MAX = 1.2;

/** Formats GET /v1/upload/credential accepts, by media kind. */
export const LEGACY_UPLOAD_FORMATS = {
  image: ["png", "jpg", "jpeg", "bmp", "webp"],
  audio: ["mp3", "wav", "m4a"],
  video: ["mp4", "avi", "mov"],
} as const;
export type UploadKind = keyof typeof LEGACY_UPLOAD_FORMATS;

/** Every upload format, for `topview upload`. */
export const ALL_UPLOAD_FORMATS: readonly string[] = Object.values(LEGACY_UPLOAD_FORMATS).flat();

// ---------------------------------------------------------------------------
// Legacy task kinds and statuses
// ---------------------------------------------------------------------------

export interface LegacyKindSpec {
  queryPath: string;
  label: string;
}

/** Documented query endpoint for every task kind multix submits. */
export const LEGACY_TASK_KINDS: Readonly<Record<LegacyTaskKind, LegacyKindSpec>> = {
  m2v: { queryPath: "/v1/m2v/task/query", label: "URL/materials-to-video" },
  "video-avatar": { queryPath: "/v1/video_avatar/task/query", label: "video avatar" },
  "remove-bg": {
    queryPath: "/v1/common_task/remove_background/query",
    label: "remove background",
  },
  "product-avatar-replace": {
    queryPath: "/v3/product_avatar/task/image_replace/query",
    label: "product avatar: replace product image",
  },
  "product-avatar-video": {
    queryPath: "/v3/product_avatar/task/image2Video/query",
    label: "product avatar: image to video",
  },
  "anyshoot-try-on": {
    queryPath: "/v3/product_anyShoot/product_model/task/result",
    label: "product anyshoot: try-on",
  },
  "anyshoot-background": {
    queryPath: "/v3/product_anyShoot/product_background/task/query",
    label: "product anyshoot: background",
  },
};

export const LEGACY_TASK_KIND_NAMES = Object.keys(LEGACY_TASK_KINDS) as LegacyTaskKind[];

export function assertLegacyTaskKind(kind: string): LegacyTaskKind {
  if (!(kind in LEGACY_TASK_KINDS)) {
    throw new ValidationError(
      `Unknown TopView task kind "${kind}". Use one of: ${LEGACY_TASK_KIND_NAMES.join(", ")}`,
    );
  }
  return kind as LegacyTaskKind;
}

/** Legacy terminal statuses; anything else (init, running, unknown) keeps polling. */
export function isLegacyTerminalStatus(status: string | undefined): boolean {
  return status === "success" || status === "fail";
}

/** Platform terminal statuses for the CLI (payment_required needs a top-up first). */
export function isPlatformTerminalStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "payment_required";
}

// ---------------------------------------------------------------------------
// IDs: validated before they reach a URL path or query string
// ---------------------------------------------------------------------------

/** Legacy task and file ids are 32 hex characters in the docs; allow a safe superset. */
const LEGACY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Platform prediction ids are alphanumeric (the official sample checks /^[a-zA-Z0-9]+$/). */
const PREDICTION_ID_RE = /^[A-Za-z0-9]{1,128}$/;

export function isValidLegacyId(id: unknown): id is string {
  return typeof id === "string" && LEGACY_ID_RE.test(id);
}

export function assertLegacyId(id: string, what = "task id"): string {
  const trimmed = id.trim();
  if (!LEGACY_ID_RE.test(trimmed)) {
    throw new ValidationError(
      `Invalid TopView ${what} "${id}": expected letters, digits, "_" or "-" (at most 128)`,
    );
  }
  return trimmed;
}

export function isValidPredictionId(id: unknown): id is string {
  return typeof id === "string" && PREDICTION_ID_RE.test(id);
}

export function assertPredictionId(id: string): string {
  const trimmed = id.trim();
  if (!PREDICTION_ID_RE.test(trimmed)) {
    throw new ValidationError(
      `Invalid TopView prediction id "${id}": expected letters and digits only`,
    );
  }
  return trimmed;
}

/** Idempotency keys: printable ASCII without spaces, at most 255 characters. */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,255}$/;

export function assertIdempotencyKey(key: string): string {
  const trimmed = key.trim();
  if (!IDEMPOTENCY_KEY_RE.test(trimmed)) {
    throw new ValidationError(
      "--idempotency-key must be 8-255 letters, digits, '.', '_', ':' or '-' (reuse the key a previous run printed)",
    );
  }
  return trimmed;
}

/** costCredit arrives as a number (1.00) or a numeric string ("5.00"); anything else is absent. */
export function parseCredit(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return undefined;
}

// ---------------------------------------------------------------------------
// API Platform: verified prediction routes
// ---------------------------------------------------------------------------

/**
 * Top-level shape of a route's request body (bodies are model-native and the
 * server rejects unknown keys):
 * - "input-parameters": `{ input: {...}, parameters?: {...} }` (Wan 3.0)
 * - "content": `{ content: [...], ratio?, resolution?, duration?, ... }` (Seedance, MiniMax, T1)
 * - "prompt": flat `{ prompt, ... }` (GPT Image 2)
 */
export type BodyFamily = "input-parameters" | "content" | "prompt";

export interface PlatformRoute {
  /** `{provider}/{model}/{mode}` as used in /api/v1/models/{route}/predictions. */
  route: string;
  family: BodyFamily;
  /** `displayName` of the matching public catalog entry (the catalog has no route slug). */
  catalogName: string;
  category: "video" | "image";
  source: string;
  verified_at: string;
}

const PLATFORM_SOURCE = "https://platform.topview.ai/llms-full.txt";
const VERIFIED_AT = "2026-10-28";

function routes(
  base: string,
  modes: readonly string[],
  family: BodyFamily,
  catalogName: string,
  category: "video" | "image",
): PlatformRoute[] {
  return modes.map((mode) => ({
    route: `${base}/${mode}`,
    family,
    catalogName,
    category,
    source: PLATFORM_SOURCE,
    verified_at: VERIFIED_AT,
  }));
}

const SEEDANCE_MODES = ["image-to-video", "text-to-video", "omni-reference-to-video"] as const;

/** Every route documented in the API Platform docs on 2026-10-28; nothing else is sent. */
export const PLATFORM_ROUTES: readonly PlatformRoute[] = [
  ...routes(
    "alibaba/wan-3.0",
    ["image-to-video", "text-to-video", "reference-to-video"],
    "input-parameters",
    "Wan 3.0",
    "video",
  ),
  ...routes("bytedance/seedance-2.5", SEEDANCE_MODES, "content", "Seedance 2.5", "video"),
  ...routes("bytedance/seedance-2.0", SEEDANCE_MODES, "content", "Seedance 2.0", "video"),
  ...routes("bytedance/seedance-2.0-fast", SEEDANCE_MODES, "content", "Seedance 2.0 Fast", "video"),
  ...routes("bytedance/seedance-2.0-mini", SEEDANCE_MODES, "content", "Seedance 2.0 Mini", "video"),
  ...routes(
    "minimax/minimax-h3",
    ["image-to-video", "text-to-video"],
    "content",
    "MiniMax H3",
    "video",
  ),
  ...routes("topview/topview-t1", SEEDANCE_MODES, "content", "Topview T1", "video"),
  ...routes("openai/gpt-image-2", ["text-to-image", "edit"], "prompt", "GPT Image 2", "image"),
];

const ROUTES_BY_NAME = new Map(PLATFORM_ROUTES.map((r) => [r.route, r]));

/** Return the verified route, or throw before any request is made. */
export function assertPlatformRoute(route: string): PlatformRoute {
  const spec = ROUTES_BY_NAME.get(route.trim());
  if (!spec) {
    throw new ValidationError(
      `Unsupported TopView API Platform route "${route}". Verified routes (see \`multix topview models\`): ${PLATFORM_ROUTES.map((r) => r.route).join(", ")}`,
    );
  }
  return spec;
}

const FAMILY_HINT: Record<BodyFamily, string> = {
  "input-parameters": '{"input":{"prompt":...,"media":[...]},"parameters":{...}}',
  content: '{"content":[{"type":"text","text":...}],"ratio":...,"resolution":...}',
  prompt: '{"prompt":...,"resolution":...,"quality":...}',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reject a body whose top-level keys do not match the route's shape family,
 * before anything is sent or billed. Field-level checks stay with the server.
 */
export function assertBodyFamily(spec: PlatformRoute, body: unknown): Record<string, unknown> {
  if (!isPlainObject(body)) throw new ValidationError("--input must be a JSON object");
  const keys = Object.keys(body);
  const fail = (why: string): never => {
    throw new ValidationError(
      `--input does not match ${spec.route} (${spec.family} body): ${why}. Expected a body like ${FAMILY_HINT[spec.family]}`,
    );
  };
  if ("model" in body) fail('"model" comes from the route; remove it from the body');
  if (spec.family === "input-parameters") {
    if (!isPlainObject(body.input)) fail('"input" must be an object');
    if (body.parameters !== undefined && !isPlainObject(body.parameters)) {
      fail('"parameters" must be an object');
    }
    const extra = keys.filter((k) => k !== "input" && k !== "parameters");
    if (extra.length > 0) fail(`unexpected top-level key(s) ${extra.join(", ")}`);
  } else if (spec.family === "content") {
    if (!Array.isArray(body.content) || body.content.length === 0) {
      fail('"content" must be a non-empty array');
    }
    const foreign = keys.filter((k) => k === "input" || k === "parameters" || k === "prompt");
    if (foreign.length > 0) fail(`top-level key(s) ${foreign.join(", ")} belong to another family`);
  } else {
    if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
      fail('"prompt" must be a non-empty string');
    }
    const foreign = keys.filter((k) => k === "input" || k === "parameters" || k === "content");
    if (foreign.length > 0) fail(`top-level key(s) ${foreign.join(", ")} belong to another family`);
  }
  return body;
}
