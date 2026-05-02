/**
 * Gemini model constants and defaults.
 * Mirrors the Python source model registry.
 */

/** Default image generation model (Nano Banana 2 — fastest, ~95% Pro quality). */
export const IMAGE_MODEL_DEFAULT = "gemini-3.1-flash-image-preview";

/** Fallback if default image model fails. */
export const IMAGE_MODEL_FALLBACK = "gemini-2.5-flash-image";

/** Default video generation model (Veo). */
export const VIDEO_MODEL_DEFAULT = "veo-3.1-generate-preview";

/** Default multimodal analysis/transcription model. */
export const ANALYSIS_MODEL_DEFAULT = "gemini-2.5-flash";

/** Default document conversion model. */
export const DOC_MODEL_DEFAULT = "gemini-2.5-flash";

/** Imagen 4 model ids — require billing, use generateImages API. */
export const IMAGEN_MODELS = new Set([
  "imagen-4.0-generate-001",
  "imagen-4.0-ultra-generate-001",
  "imagen-4.0-fast-generate-001",
]);

/** All valid Gemini image-capable models (generate_content API). */
export const GEMINI_IMAGE_MODELS = new Set([
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
  "gemini-2.5-flash-image",
  "gemini-2.5-flash-image-preview",
  ...IMAGEN_MODELS,
]);

/** Supported aspect ratios for image/video generation. */
export const ASPECT_RATIOS = [
  "1:1", "2:3", "3:2", "3:4", "4:3",
  "4:5", "5:4", "9:16", "16:9", "21:9",
] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/** Supported image sizes (Nano Banana / Imagen). */
export const IMAGE_SIZES = ["1K", "2K", "4K"] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

/**
 * Get default model for a given task, with env overrides matching the Python source.
 */
export function getDefaultModel(task: "generate" | "generate-video" | "analyze" | "transcribe" | "extract"): string {
  if (task === "generate") {
    return process.env["IMAGE_GEN_MODEL"] ?? process.env["GEMINI_IMAGE_GEN_MODEL"] ?? IMAGE_MODEL_DEFAULT;
  }
  if (task === "generate-video") {
    return process.env["VIDEO_GEN_MODEL"] ?? VIDEO_MODEL_DEFAULT;
  }
  // analyze / transcribe / extract
  return process.env["MULTIMODAL_MODEL"] ?? process.env["GEMINI_MODEL"] ?? ANALYSIS_MODEL_DEFAULT;
}
