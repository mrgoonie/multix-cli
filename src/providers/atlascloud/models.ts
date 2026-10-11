/**
 * Atlas Cloud endpoints and verified default model ids.
 * Runtime-neutral: env overrides are resolved in the Node command layer.
 *
 * Defaults are listed in https://www.atlascloud.ai/docs/openapi-index and the
 * public catalog (GET /api/v1/models); each was picked as the cheapest or
 * documented-example model for its task. Any catalog model id works via -m.
 */

import type { AtlasMediaKind } from "./types.js";

/** Provider name used in errors and URL-policy messages. */
export const ATLAS_PROVIDER = "atlascloud";

/** Media API base (image/video/audio/upload/predictions). The LLM base is /v1 and is not used. */
export const DEFAULT_ATLAS_BASE_URL = "https://api.atlascloud.ai/api/v1";

export const SUBMIT_PATHS: Record<AtlasMediaKind, string> = {
  image: "/model/generateImage",
  video: "/model/generateVideo",
  audio: "/model/generateAudio",
};

export const ATLAS_MEDIA_KINDS: readonly AtlasMediaKind[] = ["image", "video", "audio"];

export const ATLAS_DEFAULT_MODELS = {
  /** FLUX.1 [schnell], $0.003/image — fastest, cheapest text-to-image. */
  image: "black-forest-labs/flux-schnell",
  /** GPT Image 1 Mini edit — cheapest image edit; takes `images[]`. */
  imageEdit: "openai/gpt-image-1-mini/edit",
  /** Seedance 1.0 Pro Fast — low-cost text-to-video, 2-12s, 480p-1080p. */
  video: "bytedance/seedance-v1-pro-fast/text-to-video",
  /** Matching image-to-video model; takes a single `image`. */
  imageToVideo: "bytedance/seedance-v1-pro-fast/image-to-video",
  /** xAI TTS v1 — cheapest text-to-speech. */
  tts: "xai/tts-v1",
  /** Seed ASR 2.0 — documented speech-to-text example; returns text. */
  stt: "bytedance/seed-asr-2.0",
  /** Hunyuan 3D Rapid — low-cost text-to-3D (GLB by default). */
  textTo3d: "tencent/hunyuan3d-rapid/text-to-3d",
  /** Hunyuan 3D Rapid — low-cost image-to-3D (GLB by default). */
  imageTo3d: "tencent/hunyuan3d-rapid/image-to-3d",
} as const;

export type AtlasDefaultModelKey = keyof typeof ATLAS_DEFAULT_MODELS;
