/**
 * fal.ai model defaults and base URL.
 * Model catalog is huge and changes often — this CLI does not hardcode a
 * registry; `multix fal run <model>` accepts any fal model id directly.
 * Sourced from https://docs.fal.ai — keep the defaults in sync.
 */

import { envDefault } from "../../core/env-default.js";

export const DEFAULT_FAL_BASE_URL = "https://queue.fal.run";

/**
 * Base URL override and the key env names in the order the provider reads
 * them (first non-blank wins). Shared by the key lookup, the base URL trust
 * check and `multix check`, so the three cannot drift apart.
 */
export const FAL_ROUTING = {
  name: "FAL_BASE_URL",
  defaultUrl: DEFAULT_FAL_BASE_URL,
  keyEnvs: ["FAL_KEY"],
} as const;

// Getters, so the env is read when a command runs, after loadEnv().
export const FAL_DEFAULTS = {
  // FLUX.1 [schnell] — fast, low-cost default text-to-image model.
  get imageModel() {
    return envDefault("FAL_IMAGE_MODEL", "fal-ai/flux/schnell");
  },
  // Stable, widely available default text-to-video model.
  get videoModel() {
    return envDefault("FAL_VIDEO_MODEL", "fal-ai/kling-video/v1.6/standard/text-to-video");
  },
  // Matching image-to-video model — used when --image-url is passed without -m.
  get videoImageModel() {
    return envDefault("FAL_VIDEO_IMAGE_MODEL", "fal-ai/kling-video/v1.6/standard/image-to-video");
  },
  // Text-to-speech default for `fal tts`; see speech-models.ts for the verified list.
  get ttsModel() {
    return envDefault("FAL_TTS_MODEL", "google/gemini-3.8-flash-tts");
  },
} as const;
