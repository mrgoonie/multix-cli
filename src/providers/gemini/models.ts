/**
 * Gemini model constants and defaults.
 * Mirrors the Python source model registry.
 */

import { envDefault } from "../../core/env-default.js";
import { ValidationError } from "../../core/errors.js";

/** Default image generation model (Nano Banana 2 — fastest, ~95% Pro quality). */
export const IMAGE_MODEL_DEFAULT = "gemini-3.1-flash-image-preview";

/** Fallback if default image model fails. */
export const IMAGE_MODEL_FALLBACK = "gemini-2.5-flash-image";

/** Gemini Omni Flash (GA): video generation and editing over the Interactions API. */
export const GEMINI_OMNI_MODEL_DEFAULT = "gemini-omni-1.1-flash";

/** Default video generation model. Veo models stay usable with an explicit `--model`. */
export const VIDEO_MODEL_DEFAULT = GEMINI_OMNI_MODEL_DEFAULT;

/**
 * Shutdown dates from https://ai.google.dev/gemini-api/docs/deprecations for
 * video models a caller may still name explicitly. They are never rerouted to
 * another model; the command warns and sends the request as asked.
 */
export const VIDEO_MODEL_SHUTDOWN_DATES: Readonly<Record<string, string>> = {
  "veo-3.1-generate-preview": "2026-10-22",
  "veo-3.1-fast-generate-preview": "2026-10-22",
  "veo-3.1-lite-generate-preview": "2026-10-22",
  "gemini-omni-flash-preview": "2026-10-22",
  "veo-3.0-generate-001": "2026-06-30",
  "veo-3.0-fast-generate-001": "2026-06-30",
  "veo-2.0-generate-001": "2026-06-30",
  "veo-3.0-generate-preview": "2025-11-12",
  "veo-3.0-fast-generate-preview": "2025-11-12",
};

/** Warning text for a deprecated video model, or undefined when none is announced. */
export function videoModelDeprecation(model: string, today = new Date()): string | undefined {
  const id = model.replace(/^models\//, "");
  const date = VIDEO_MODEL_SHUTDOWN_DATES[id];
  if (!date) return undefined;
  const past = today.toISOString().slice(0, 10) >= date;
  return `${id} ${past ? "was shut down on" : "shuts down on"} ${date}; use ${GEMINI_OMNI_MODEL_DEFAULT} instead`;
}

/** Default text-output model for multimodal analysis, transcription, extraction, and docs. */
export const TEXT_MODEL_DEFAULT = "gemini-3.6-flash";

/** Default multimodal analysis/transcription model. */
export const ANALYSIS_MODEL_DEFAULT = TEXT_MODEL_DEFAULT;

/** Default TTS model. */
export const TTS_MODEL_DEFAULT = "gemini-3.8-flash-lite-tts";

/** Default document conversion model. */
export const DOC_MODEL_DEFAULT = TEXT_MODEL_DEFAULT;

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
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/** Supported image sizes (Nano Banana / Imagen). */
export const IMAGE_SIZES = ["1K", "2K", "4K"] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

/**
 * Get default model for a given task, with env overrides matching the Python source.
 */
export function getDefaultModel(
  task: "generate" | "generate-video" | "generate-speech" | "analyze" | "transcribe" | "extract",
): string {
  // A blank name (as in a copied .env.example) falls through to the next one.
  if (task === "generate") {
    return envDefault("IMAGE_GEN_MODEL", envDefault("GEMINI_IMAGE_GEN_MODEL", IMAGE_MODEL_DEFAULT));
  }
  if (task === "generate-video") {
    return envDefault("VIDEO_GEN_MODEL", VIDEO_MODEL_DEFAULT);
  }
  if (task === "generate-speech") {
    return envDefault("GEMINI_TTS_MODEL", envDefault("TTS_MODEL", TTS_MODEL_DEFAULT));
  }
  // analyze / transcribe / extract
  return envDefault("MULTIMODAL_MODEL", envDefault("GEMINI_MODEL", ANALYSIS_MODEL_DEFAULT));
}

/**
 * Which video adapter serves a model: Gemini Omni (Interactions API) or Veo
 * (predictLongRunning). Any other model is rejected rather than rerouted.
 */
export function videoModelFamily(model: string): "omni" | "veo" {
  const id = model.replace(/^models\//, "");
  if (id.startsWith("gemini-omni-")) return "omni";
  if (id.startsWith("veo-")) return "veo";
  throw new ValidationError(
    `'${model}' is not a Gemini video model. Use ${GEMINI_OMNI_MODEL_DEFAULT} (default) or a Veo model such as veo-3.1-generate-preview.`,
  );
}
