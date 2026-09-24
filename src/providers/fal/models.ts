/**
 * fal.ai model defaults and base URL.
 * Model catalog is huge and changes often — this CLI does not hardcode a
 * registry; `multix fal run <model>` accepts any fal model id directly.
 * Sourced from https://docs.fal.ai — keep the defaults in sync.
 */

export const DEFAULT_FAL_BASE_URL = "https://queue.fal.run";

export const FAL_DEFAULTS = {
  // FLUX.1 [schnell] — fast, low-cost default text-to-image model.
  imageModel: process.env.FAL_IMAGE_MODEL ?? "fal-ai/flux/schnell",
  // Stable, widely available default text-to-video model.
  videoModel: process.env.FAL_VIDEO_MODEL ?? "fal-ai/kling-video/v1.6/standard/text-to-video",
} as const;
