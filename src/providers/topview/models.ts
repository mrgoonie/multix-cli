/**
 * TopView endpoints, task kinds and the verified API Platform routes.
 * Runtime-neutral: env overrides are resolved in the Node command layer.
 *
 * TopView has two separate APIs with separate keys and separate money:
 * - the legacy API (https://docs.topview.ai) spends the credits of the
 *   topview.ai web plan and authenticates with a key plus `Topview-Uid`;
 * - the API Platform (https://platform.topview.ai/docs) spends a separate USD
 *   balance and authenticates with its own Bearer key.
 * Neither key ever falls back to the other.
 */

/** Provider name used in errors and URL-policy messages. */
export const TOPVIEW_PROVIDER = "topview";

export const DEFAULT_TOPVIEW_BASE_URL = "https://api.topview.ai";
export const DEFAULT_TOPVIEW_PLATFORM_BASE_URL = "https://platform-backend.topview.ai";

export const TOPVIEW_KEY_URL = "https://www.topview.ai/dashboard/home";
export const TOPVIEW_PLATFORM_KEY_URL = "https://platform.topview.ai";

/** Legacy API: key env, base URL override. `TOPVIEW_UID` is sent alongside the key. */
export const TOPVIEW_LEGACY_ROUTING = {
  name: "TOPVIEW_BASE_URL",
  defaultUrl: DEFAULT_TOPVIEW_BASE_URL,
  keyEnvs: ["TOPVIEW_API_KEY"],
} as const;

/** API Platform: its own key (the name the official docs use) and base URL override. */
export const TOPVIEW_PLATFORM_ROUTING = {
  name: "TOPVIEW_PLATFORM_BASE_URL",
  defaultUrl: DEFAULT_TOPVIEW_PLATFORM_BASE_URL,
  keyEnvs: ["TOPVIEW_API_PLATFORM_KEY"],
} as const;

export const TOPVIEW_UID_ENV = "TOPVIEW_UID";

/** Legacy async task kinds: where each one is submitted and queried. */
export const LEGACY_TASKS = {
  /** Avatar Marketing Video (product link or uploaded materials). */
  m2v: { submit: "/v1/m2v/task/submit", query: "/v1/m2v/task/query" },
  /** Export a script of an m2v task submitted with preview. Queried as m2v. */
  "m2v-export": { submit: "/v1/m2v/export", query: "/v1/m2v/task/query" },
  "video-avatar": { submit: "/v1/video_avatar/task/submit", query: "/v1/video_avatar/task/query" },
  "product-avatar-image": {
    submit: "/v3/product_avatar/task/image_replace/submit",
    query: "/v3/product_avatar/task/image_replace/query",
  },
  "product-avatar-video": {
    submit: "/v3/product_avatar/task/image2Video/submit",
    query: "/v3/product_avatar/task/image2Video/query",
  },
  "anyshoot-model": {
    submit: "/v3/product_anyShoot/product_model/task/submit",
    query: "/v3/product_anyShoot/product_model/task/result",
  },
  "anyshoot-background": {
    submit: "/v3/product_anyShoot/product_background/task/submit",
    query: "/v3/product_anyShoot/product_background/task/query",
  },
} as const;

export type LegacyTaskKind = keyof typeof LEGACY_TASKS;

/** Kinds `topview status --task` accepts; m2v-export is read through m2v. */
export const STATUS_TASK_KINDS = [
  "m2v",
  "video-avatar",
  "product-avatar-image",
  "product-avatar-video",
  "anyshoot-model",
  "anyshoot-background",
  "platform",
] as const;

export type StatusTaskKind = (typeof STATUS_TASK_KINDS)[number];

export function isLegacyTaskKind(value: string): value is LegacyTaskKind {
  return Object.hasOwn(LEGACY_TASKS, value);
}

/** Upload formats the legacy credential endpoint accepts (docs: Get Upload Credential). */
export const LEGACY_UPLOAD_FORMATS = [
  "png",
  "jpg",
  "jpeg",
  "bmp",
  "webp",
  "mp3",
  "wav",
  "m4a",
  "mp4",
  "avi",
  "mov",
] as const;

/** Media kinds of the Platform asset upload, by file extension (20 MiB max). */
export const PLATFORM_UPLOAD_KINDS: Readonly<Record<string, "image" | "video" | "audio">> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  mp4: "video",
  mov: "video",
  webm: "video",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
};

export const PLATFORM_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const PLATFORM_DOCS_SOURCE = "https://platform.topview.ai/llms-full.txt";
export const PLATFORM_VERIFIED_AT = "2026-10-28";

export interface PlatformRoute {
  owner: string;
  model: string;
  mode: string;
  output: "video" | "image";
}

const video = (owner: string, model: string, modes: string[]): PlatformRoute[] =>
  modes.map((mode) => ({ owner, model, mode, output: "video" }));

const SEEDANCE_MODES = ["text-to-video", "image-to-video", "omni-reference-to-video"];

/**
 * Prediction routes the Platform docs list as available on PLATFORM_VERIFIED_AT.
 * Each model takes its own native JSON body; the server validates it.
 */
export const PLATFORM_ROUTES: readonly PlatformRoute[] = [
  ...video("alibaba", "wan-3.0", ["text-to-video", "image-to-video", "reference-to-video"]),
  ...video("bytedance", "seedance-2.5", SEEDANCE_MODES),
  ...video("bytedance", "seedance-2.0", SEEDANCE_MODES),
  ...video("bytedance", "seedance-2.0-fast", SEEDANCE_MODES),
  ...video("bytedance", "seedance-2.0-mini", SEEDANCE_MODES),
  ...video("minimax", "minimax-h3", ["text-to-video", "image-to-video"]),
  ...video("topview", "topview-t1", SEEDANCE_MODES),
  { owner: "openai", model: "gpt-image-2", mode: "text-to-image", output: "image" },
  { owner: "openai", model: "gpt-image-2", mode: "edit", output: "image" },
];

export function routeId(r: PlatformRoute): string {
  return `${r.owner}/${r.model}/${r.mode}`;
}

/** Find a verified route by `owner/model/mode`; undefined when not listed. */
export function findPlatformRoute(id: string): PlatformRoute | undefined {
  return PLATFORM_ROUTES.find((r) => routeId(r) === id.trim());
}
