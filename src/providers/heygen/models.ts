/**
 * HeyGen v3 constants: base URL, documented enum values, limits, and the
 * operation registry used by `heygen run`. Runtime-neutral (no node:* imports).
 * Values verified against https://developers.heygen.com (v3 reference pages).
 */

export const DEFAULT_HEYGEN_BASE_URL = "https://api.heygen.com";

/**
 * Base URL override and the key env names in the order the provider reads
 * them (first non-blank wins). Shared by the key lookup, the base URL trust
 * check and `multix check`, so the three cannot drift apart.
 */
export const HEYGEN_ROUTING = {
  name: "HEYGEN_BASE_URL",
  defaultUrl: DEFAULT_HEYGEN_BASE_URL,
  keyEnvs: ["HEYGEN_API_KEY"],
} as const;

/** Where users create or manage API keys and API credits (separate from web plans). */
export const HEYGEN_API_SETTINGS_URL = "https://app.heygen.com/developers/api";
export const HEYGEN_USAGE_URL = "https://app.heygen.com/developers/usage";

export const AVATAR_VIDEO_RESOLUTIONS = ["4k", "1080p", "720p"] as const;
export const AVATAR_VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "4:5", "5:4", "1:1", "auto"] as const;
export const AVATAR_ENGINES = ["avatar_iv", "avatar_v", "avatar_iii"] as const;
export const EXPRESSIVENESS_LEVELS = ["high", "medium", "low"] as const;
export const AVATAR_TYPES = ["studio_avatar", "digital_twin", "photo_avatar"] as const;
export const OWNERSHIP_VALUES = ["public", "private"] as const;
export const AGENT_ORIENTATIONS = ["landscape", "portrait"] as const;
export const QUALITY_MODES = ["speed", "precision"] as const;
export const SPEECH_ENGINES = ["starfish", "orca", "elevenlabs"] as const;

export const HEYGEN_VIDEO_MODEL = "heygen-video-1";
export const MODEL_VIDEO_MODES = ["text_to_video", "image_to_video", "reference_to_video"] as const;
export const MODEL_VIDEO_RESOLUTIONS = ["480p", "768p", "1080p", "2k"] as const;
export const MODEL_VIDEO_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
  "adaptive",
] as const;
export const MODEL_VIDEO_PROMPT_ENHANCEMENT = ["turbo", "quality", "disabled"] as const;

/** Documented input limits. */
export const LIMITS = {
  agentPromptMax: 10_000,
  agentFilesMax: 20,
  scriptMax: 5_000,
  speechTextMax: 5_000,
  /** POST /v3/assets single-request upload cap (32 MB). */
  assetUploadMaxBytes: 32 * 1024 * 1024,
  modelVideoPromptMax: 32_000,
  modelVideoMinDuration: 5,
  modelVideoMaxDuration: 15,
  modelVideoReferenceImagesMax: 9,
  modelVideoReferenceVideosMax: 3,
  modelVideoReferenceAudioMax: 3,
  /** Combined cap across reference images, videos and audio. */
  modelVideoReferenceTotalMax: 12,
  avatarListMax: 50,
  voiceListMax: 100,
  stylesListMax: 100,
} as const;

/** File types POST /v3/assets accepts, keyed by lowercase extension. */
export const ASSET_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pdf: "application/pdf",
  srt: "application/x-subrip",
};

/** Asynchronous job families. Each has its own status endpoint and status vocabulary. */
export type HeygenJobKind = "agent" | "video" | "translation" | "lipsync" | "model-video";
export const JOB_KINDS: readonly HeygenJobKind[] = [
  "agent",
  "video",
  "translation",
  "lipsync",
  "model-video",
];

export interface HeygenOperation {
  description: string;
  path: string;
  /** Async job family to poll, or null for synchronous operations. */
  kind: HeygenJobKind | null;
  /** Response field(s) holding the job id(s). */
  idField?: string;
  idsField?: string;
  /** Endpoint documents the optional `Idempotency-Key` header. */
  idempotent: boolean;
}

/**
 * Documented v3 create operations exposed by `heygen run`. The payload is
 * forwarded verbatim, so each keeps its own schema and status type.
 */
export const HEYGEN_OPERATIONS: Record<string, HeygenOperation> = {
  "video-agent": {
    description: "POST /v3/video-agents (prompt-to-video session)",
    path: "/v3/video-agents",
    kind: "agent",
    idField: "session_id",
    idempotent: false,
  },
  video: {
    description: "POST /v3/videos (avatar | image | cinematic_avatar | studio)",
    path: "/v3/videos",
    kind: "video",
    idField: "video_id",
    idempotent: true,
  },
  "video-translation": {
    description: "POST /v3/video-translations",
    path: "/v3/video-translations",
    kind: "translation",
    idsField: "video_translation_ids",
    idempotent: true,
  },
  lipsync: {
    description: "POST /v3/lipsyncs",
    path: "/v3/lipsyncs",
    kind: "lipsync",
    idField: "lipsync_id",
    idempotent: true,
  },
  "model-video": {
    description: "POST /v3/models/videos (HeyGen Video model)",
    path: "/v3/models/videos",
    kind: "model-video",
    idField: "video_id",
    idempotent: true,
  },
  speech: {
    description: "POST /v3/voices/speech (synchronous text-to-speech)",
    path: "/v3/voices/speech",
    kind: null,
    idempotent: false,
  },
};
