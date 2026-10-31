/**
 * Gemini model constants and defaults.
 * Mirrors the Python source model registry.
 */

import { envDefault } from "../../core/env-default.js";
import { TTS_MODEL_DEFAULT } from "./voices.js";

/**
 * Default image generation model (Nano Banana 2, GA). The `-preview` id it
 * replaces is past its earliest shutdown date (2026-06-25).
 */
export const IMAGE_MODEL_DEFAULT = "gemini-3.1-flash-image";

/** Fallback if default image model fails. */
export const IMAGE_MODEL_FALLBACK = "gemini-2.5-flash-image";

/** GA Gemini Omni Flash video model (Interactions API), the replacement for the Veo 3.1 previews. */
export const GEMINI_OMNI_MODEL_DEFAULT = "gemini-omni-1.1-flash";

/** Default video generation model. */
export const VIDEO_MODEL_DEFAULT = GEMINI_OMNI_MODEL_DEFAULT;

/** Google shuts the Veo 3.1 preview models down on the Gemini API on this date. */
export const VEO_PREVIEW_SHUTDOWN_DATE = "2026-10-22";

/** Gemini Omni video models go through the Interactions API (`omni.ts`). */
export function isOmniVideoModel(model: string): boolean {
  return /^(models\/)?gemini-omni-/.test(model);
}

/** Veo models go through predictLongRunning (`veo.ts`). */
export function isVeoVideoModel(model: string): boolean {
  return /^(models\/)?veo-/.test(model);
}

/** Default text-output model for multimodal analysis, transcription, extraction, and docs. */
export const TEXT_MODEL_DEFAULT = "gemini-3.6-flash";

/** Default multimodal analysis/transcription model. */
export const ANALYSIS_MODEL_DEFAULT = TEXT_MODEL_DEFAULT;

/** Default TTS model (defined with the voices, which the runtime-neutral budget code reads). */
export { TTS_MODEL_DEFAULT };

/** Lyria music model capabilities (Interactions API). */
export interface LyriaMusicModel {
  id: string;
  name: string;
  /** Output containers the model can return; the first is its default. */
  outputFormats: readonly ("mp3" | "wav")[];
  /** Images accepted alongside the prompt. */
  maxImages: number;
  /** How long a generation runs. */
  duration: string;
}

/**
 * Lyria music models served by POST /v1beta/interactions
 * (https://ai.google.dev/gemini-api/docs/music-generation). Both return
 * 44.1 kHz stereo audio and take up to 10 reference images.
 */
export const LYRIA_MUSIC_MODELS: readonly LyriaMusicModel[] = [
  {
    id: "lyria-3-clip-preview",
    name: "Lyria 3 Clip (preview)",
    outputFormats: ["mp3"],
    maxImages: 10,
    duration: "always 30 seconds",
  },
  {
    id: "lyria-3.5",
    name: "Lyria 3.5",
    outputFormats: ["mp3", "wav"],
    maxImages: 10,
    duration: "a couple of minutes, steered by the prompt",
  },
];

/** The cheaper 30-second clip model is the default. */
export const MUSIC_MODEL_DEFAULT = "lyria-3-clip-preview";

export function findLyriaMusicModel(model: string): LyriaMusicModel | undefined {
  const id = model.replace(/^models\//, "");
  return LYRIA_MUSIC_MODELS.find((m) => m.id === id);
}

/** Default document conversion model. */
export const DOC_MODEL_DEFAULT = TEXT_MODEL_DEFAULT;

/**
 * Gemini image-capable models (generateContent API). Imagen 4 and
 * gemini-2.5-flash-image-preview are no longer served; the `-preview` ids
 * below are past their earliest shutdown date and may stop at any time.
 */
export const GEMINI_IMAGE_MODELS = new Set([
  "gemini-nano-banana-2.1",
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image",
  "gemini-3-pro-image",
  "gemini-2.5-flash-image",
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
]);

/** Supported aspect ratios for image generation (video models have their own lists). */
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

/** Supported image sizes (Nano Banana). */
export const IMAGE_SIZES = ["1K", "2K", "4K"] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

/**
 * Get default model for a given task, with env overrides matching the Python source.
 */
export function getDefaultModel(
  task:
    | "generate"
    | "generate-video"
    | "generate-speech"
    | "generate-music"
    | "analyze"
    | "transcribe"
    | "extract",
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
  if (task === "generate-music") {
    return envDefault("GEMINI_MUSIC_MODEL", MUSIC_MODEL_DEFAULT);
  }
  // analyze / transcribe / extract
  return envDefault("MULTIMODAL_MODEL", envDefault("GEMINI_MODEL", ANALYSIS_MODEL_DEFAULT));
}
