/**
 * Leonardo model registries and task defaults.
 * Video models are a hardcoded enum — Leonardo's API has no list endpoint.
 * Sourced from https://docs.leonardo.ai/llms.txt — keep in sync.
 */

export const DEFAULT_LEONARDO_BASE_URL = "https://cloud.leonardo.ai/api/rest/v1";

// Lucid Origin — fast, broadly available default image model.
export const DEFAULT_LEONARDO_MODEL_ID = "7b592283-e8a7-4c5a-9ba6-d18c31f258b9";

export const LEONARDO_DEFAULTS = {
  modelId: process.env.LEONARDO_DEFAULT_MODEL ?? DEFAULT_LEONARDO_MODEL_ID,
  videoModel: process.env.LEONARDO_VIDEO_MODEL ?? "MOTION2",
  width: 1024,
  height: 1024,
  numImages: 1,
} as const;

export const LEONARDO_VIDEO_MODELS = [
  { id: "MOTION2", name: "Motion 2.0", modes: ["t2v", "i2v"] },
  { id: "MOTION2FAST", name: "Motion 2.0 Fast", modes: ["t2v", "i2v"] },
  { id: "VEO3", name: "Veo 3.0", modes: ["t2v", "i2v"] },
  { id: "VEO3FAST", name: "Veo 3.0 Fast", modes: ["t2v"] },
  { id: "VEO3_1", name: "Veo 3.1", modes: ["t2v", "i2v"] },
  { id: "KLING2_1", name: "Kling 2.1 Pro", modes: ["t2v", "i2v"] },
  { id: "Kling2_5", name: "Kling 2.5 Turbo", modes: ["t2v", "i2v"] },
  { id: "kling-2.6", name: "Kling 2.6", modes: ["t2v", "i2v"] },
  { id: "kling-3.0", name: "Kling 3.0", modes: ["t2v"] },
  { id: "kling-video-o-1", name: "Kling O1", modes: ["t2v", "i2v"] },
  { id: "kling-video-o-3", name: "Kling O3", modes: ["t2v", "i2v"] },
  { id: "hailuo-2_3", name: "Hailuo 2.3", modes: ["t2v", "i2v"] },
  { id: "ltxv-2.0-pro", name: "LTX 2.0 Pro", modes: ["t2v", "i2v"] },
  { id: "ltxv-2.3-pro", name: "LTX 2.3 Pro", modes: ["t2v", "i2v"] },
  { id: "seedance-2.0", name: "Seedance 2.0", modes: ["t2v", "i2v"] },
  { id: "seedance-2.0-fast", name: "Seedance 2.0 Fast", modes: ["t2v", "i2v"] },
] as const;

export const LEONARDO_VIDEO_RESOLUTIONS = [
  "RESOLUTION_480",
  "RESOLUTION_720",
  "RESOLUTION_1080",
] as const;

// Video model ids that dispatch to the v2 endpoint (string-style ids).
// v1 enum-style ids (uppercase like MOTION2, VEO3) use /generations-text-to-video.
export const LEONARDO_V2_VIDEO_MODELS = new Set<string>([
  "kling-2.6",
  "kling-3.0",
  "kling-video-o-1",
  "kling-video-o-3",
  "hailuo-2_3",
  "ltxv-2.0-pro",
  "ltxv-2.3-pro",
  "seedance-2.0",
  "seedance-2.0-fast",
]);

/** GPT Image family routes through the v2 endpoint with a different request shape. */
export function isGptImageModel(modelId: string | undefined): boolean {
  return typeof modelId === "string" && modelId.startsWith("gpt-image-");
}
