/**
 * BytePlus ModelArk model registry and defaults.
 * - Seedream 4.0 — image generation (sync, OpenAI-compat /images/generations)
 * - Seedance 2.0 family — async video generation (/contents/generations/tasks)
 * Sourced from BytePlus ModelArk docs; keep in sync when new model variants ship.
 */

export const DEFAULT_BYTEPLUS_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3";

export const DEFAULT_BYTEPLUS_IMAGE_MODEL = "seedream-4-0-250828";
export const DEFAULT_BYTEPLUS_VIDEO_MODEL = "seedance-2.0";
export const DEFAULT_BYTEPLUS_3D_MODEL = "hyper3d-gen2-260112";

export const BYTEPLUS_VIDEO_MODELS = [
  { id: "seedance-2.0-fast", name: "Seedance 2.0 Fast" },
  { id: "seedance-2.0", name: "Seedance 2.0" },
  { id: "seedance-2.0-pro", name: "Seedance 2.0 Pro" },
] as const;

/**
 * 3D generation models on the ARK tasks endpoint.
 * - Hyper3D Gen2: text-to-3D and image-to-3D (1–5 reference images), supports
 *   `--mesh_mode`, `--hd_texture`, `--material`, `--addons`, `--quality_override`,
 *   `--use_original_alpha`, `--bbox_condition`, `--TAPose` flags inside the prompt.
 * - Hitem3d 2.0: image-to-3D, supports `--ff` and `--resolution` flags.
 */
export const BYTEPLUS_3D_MODELS = [
  { id: "hyper3d-gen2-260112", name: "Hyper3D Gen2", family: "hyper3d" },
  { id: "hitem3d-2-0-251223", name: "Hitem3d 2.0", family: "hitem3d" },
] as const;

export const BYTEPLUS_DEFAULTS = {
  imageModel: process.env.BYTEPLUS_IMAGE_MODEL ?? DEFAULT_BYTEPLUS_IMAGE_MODEL,
  videoModel: process.env.BYTEPLUS_VIDEO_MODEL ?? DEFAULT_BYTEPLUS_VIDEO_MODEL,
  threeDModel: process.env.BYTEPLUS_3D_MODEL ?? DEFAULT_BYTEPLUS_3D_MODEL,
  videoResolution: "1080p",
  videoDuration: 8,
  videoAspectRatio: "16:9",
  imageSize: "2K",
} as const;

/**
 * Video param encoding mode.
 *   "flags"      — append `--rs 1080p --dur 8 --rt 16:9 ...` inside content[0].text (default)
 *   "structured" — emit top-level `parameters` object
 * Override via env BYTEPLUS_VIDEO_PARAMS_MODE.
 */
export type VideoParamsMode = "flags" | "structured";

export function bytePlusVideoParamsMode(): VideoParamsMode {
  const m = process.env.BYTEPLUS_VIDEO_PARAMS_MODE;
  return m === "structured" ? "structured" : "flags";
}
