/**
 * Input schemas of real Atlas Cloud video models, copied from their public
 * OpenAPI documents (sampled 2026-10-12) with descriptions, UI hints and
 * playground examples removed and long enums shortened. Only `properties` are
 * kept; tests use `required: ["prompt"]` so the MCP tool can reach each model.
 */
export const ATLAS_VIDEO_SCHEMAS: Record<string, Record<string, unknown>> = {
  "bytedance/seedance-2.5/text-to-video": {
    duration: {
      type: "integer",
      default: 5,
      enum: [-1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20, 25, 30],
    },
    resolution: {
      type: "string",
      default: "720p",
      enum: ["480p", "720p", "720p-sr", "1080p", "1080p-esr & 60fps", "4k-esr"],
    },
    ratio: { type: "string", default: "adaptive", enum: ["16:9", "9:16", "1:1", "adaptive"] },
    generate_audio: { type: "boolean", default: true },
    watermark: { type: "boolean", default: false },
    return_last_frame: { type: "boolean", default: false },
    output_format: { type: "string", default: "mp4", enum: ["mp4", "mov"] },
    draft: { type: "boolean", default: false },
  },
  "bytedance/seedance-2.0-mini/text-to-video": {
    duration: { type: "integer", default: 5, enum: [-1, 4, 5, 6, 8, 10, 12, 15] },
    resolution: { type: "string", default: "720p", enum: ["480p", "720p", "720p-SR", "1080p-SR"] },
    bitrate_mode: { type: "string", default: "standard", enum: ["standard", "high"] },
    generate_audio: { type: "boolean", default: true },
    seed: { type: "integer", default: -1, minimum: -1, maximum: 4294967295 },
    watermark: { type: "boolean", default: false },
  },
  "alibaba/wan-3.0-prime/reference-to-video": {
    refers: { type: "array", items: { type: "object" }, maxItems: 20 },
    resolution: {
      type: "string",
      default: "1080p",
      enum: ["1080p", "720p", "480p", "720p-esr", "1080p-esr", "1440p-esr", "4k-esr"],
    },
    duration: { type: "number", default: 5, enum: [-1, 2, 3, 4, 5, 6, 8, 10, 15, 30] },
    ratio: { type: "string", default: "adaptive", enum: ["adaptive", "16:9", "9:16"] },
    audio: { type: "boolean", default: true },
    enable_thinking: { type: "boolean", default: true },
    file: { type: "string" },
    link: { type: "string" },
    seed: { type: "integer" },
  },
  "alibaba/wan-2.5/video-extend": {
    audio: { type: "string" },
    duration: { type: "integer", default: 5, enum: [3, 4, 5, 6, 7, 8, 10] },
    negative_prompt: { type: "string" },
    resolution: { type: "string", default: "720p", enum: ["480p", "720p", "1080p"] },
    seed: { type: "integer", default: -1 },
    video: { type: "string" },
  },
  "google/gemini-omni-1.1-flash/video-extend": {
    video: { type: "string", format: "uri" },
    reference_images: { type: "array", items: { type: "string" }, maxItems: 10 },
    duration: { type: "integer", default: 10, minimum: 3, maximum: 10 },
    resolution: { type: "string", default: "720p", enum: ["360p", "720p", "1080p", "4k"] },
    thinking_level: { type: "string", default: "default", enum: ["default", "high", "low"] },
    seed: { type: "integer", default: -1 },
  },
  "midjourney/v8.2/image-to-video": {
    image: { type: "string" },
    resolution: { type: "string", default: "480p", enum: ["480p", "720p"] },
    motion: { type: "string", default: "low", enum: ["low", "high"] },
    enable_base64_output: { type: "boolean", default: false },
  },
  "pixverse/c1/text-to-video": {
    duration: { type: "integer", default: 5, enum: [1, 2, 3, 4, 5, 6, 8, 10, 15] },
    sound: { type: "boolean", default: true },
    quality: { type: "string", default: "720p", enum: ["360p", "540p", "720p", "1080p"] },
    aspect_ratio: { type: "string", default: "16:9", enum: ["16:9", "9:16", "1:1"] },
    seed: { type: "integer" },
  },
  "kwaivgi/kling-video-o3-4k/text-to-video": {
    aspect_ratio: { type: "string", default: "16:9", enum: ["16:9", "9:16", "1:1"] },
    duration: { type: "integer", default: 5, enum: [3, 4, 5, 6, 8, 10, 15] },
    sound: { type: "boolean", default: true },
    multi_shot: { type: "boolean", default: false },
    shot_type: { type: "string", enum: ["customize", "intelligence"] },
    multi_prompt: { type: "array", items: { type: "object" }, maxItems: 6 },
  },
  "luma/ray-3.2/text-to-video": {
    duration: { type: "integer", default: 5, enum: [5, 10] },
    resolution: { type: "string", default: "720p", enum: ["540p", "720p", "1080p"] },
    aspect_ratio: { type: "string", default: "16:9", enum: ["16:9", "9:16", "1:1"] },
    loop: { type: "boolean", default: false },
    hdr: { type: "boolean", default: false },
  },
};
