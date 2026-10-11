/**
 * HeyGen v3 API types — the subset multix uses.
 * Source: https://developers.heygen.com/llms.txt (OpenAPI reference pages).
 * Runtime-neutral: type declarations only.
 */

/** Standard v3 error envelope body (`{ error: {...} }`). */
export interface HeygenApiErrorBody {
  code: string;
  message: string;
  param?: string | null;
  doc_url?: string | null;
}

/** `AssetInput` union accepted by v3 endpoints (`base64` only where documented). */
export type HeygenAssetInput =
  | { type: "url"; url: string }
  | { type: "asset_id"; asset_id: string }
  | { type: "base64"; media_type: string; data: string };

/** Cursor-paginated list envelope (`{ data: [...], has_more, next_token }`). */
export interface HeygenPage<T> {
  items: T[];
  hasMore: boolean;
  nextToken: string | null;
}

export interface HeygenPageQuery {
  limit?: number;
  token?: string;
}

// ── Users ────────────────────────────────────────────────────────────────

export interface HeygenUserInfo {
  username?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  billing_type?: string;
  wallet?: unknown;
  subscription?: unknown;
  usage_based?: unknown;
  [key: string]: unknown;
}

// ── Video Agent ──────────────────────────────────────────────────────────

export interface CreateVideoAgentRequest {
  prompt: string;
  mode?: "generate" | "chat";
  avatar_id?: string;
  voice_id?: string;
  style_id?: string;
  brand_kit_id?: string;
  brand_glossary_id?: string;
  orientation?: "landscape" | "portrait";
  files?: HeygenAssetInput[];
  callback_url?: string;
  callback_id?: string;
  incognito_mode?: boolean;
}

export type VideoAgentSessionStatus =
  | "thinking"
  | "waiting_for_input"
  | "reviewing"
  | "generating"
  | "completed"
  | "failed";

export interface CreateVideoAgentResponse {
  session_id: string;
  status: VideoAgentSessionStatus | string;
  video_id?: string | null;
  created_at: number;
}

export interface VideoAgentSession {
  session_id: string;
  status: VideoAgentSessionStatus | string;
  progress?: number;
  title?: string | null;
  video_id?: string | null;
  created_at: number;
  messages?: unknown[];
  error?: { code: string; message: string } | null;
}

export interface VideoAgentStyle {
  style_id: string;
  name: string;
  thumbnail_url?: string | null;
  preview_video_url?: string | null;
  tags?: string[];
  aspect_ratio?: string | null;
}

// ── Avatar videos (POST /v3/videos, type "avatar") ───────────────────────

export type HeygenVideoResolution = "4k" | "1080p" | "720p";
export type HeygenAspectRatio = "16:9" | "9:16" | "4:5" | "5:4" | "1:1" | "auto";
export type HeygenAvatarEngine = "avatar_iv" | "avatar_v" | "avatar_iii";

export interface CreateAvatarVideoRequest {
  type: "avatar";
  avatar_id: string;
  script?: string;
  voice_id?: string;
  audio_url?: string;
  audio_asset_id?: string;
  title?: string;
  folder_id?: string;
  resolution?: HeygenVideoResolution;
  aspect_ratio?: HeygenAspectRatio;
  fit?: "contain" | "cover";
  background?:
    | { type: "color"; value: string }
    | { type: "image"; url?: string; asset_id?: string };
  remove_background?: boolean;
  output_format?: "mp4" | "webm";
  caption?: { file_format?: "srt"; style?: "default" };
  voice_settings?: { speed?: number; pitch?: number; volume?: number; locale?: string };
  motion_prompt?: string;
  expressiveness?: "high" | "medium" | "low";
  engine?: { type: HeygenAvatarEngine; reference_look_id?: string };
  brand_glossary_id?: string;
  callback_url?: string;
  callback_id?: string;
}

export interface CreateVideoResponse {
  video_id: string;
  status: string;
  output_format?: string;
}

export type HeygenVideoStatus = "pending" | "processing" | "completed" | "failed";

/** `VideoDetail` from GET /v3/videos/{id} (also returned by template generation). */
export interface HeygenVideoDetail {
  id: string;
  title?: string | null;
  status: HeygenVideoStatus | string;
  created_at?: number | null;
  completed_at?: number | null;
  video_url?: string | null;
  thumbnail_url?: string | null;
  gif_url?: string | null;
  captioned_video_url?: string | null;
  subtitle_url?: string | null;
  duration?: number | null;
  folder_id?: string | null;
  output_language?: string | null;
  failure_code?: string | null;
  failure_message?: string | null;
  video_page_url?: string | null;
}

// ── Catalog ──────────────────────────────────────────────────────────────

export interface HeygenAvatarGroup {
  id: string;
  name: string;
  preview_image_url?: string | null;
  preview_video_url?: string | null;
  gender?: string | null;
  created_at?: number;
  looks_count?: number;
  default_voice_id?: string | null;
  consent_status?: string | null;
  status?: string | null;
}

export interface HeygenAvatarLook {
  /** Look ID — pass as `avatar_id` to POST /v3/videos or /v3/video-agents. */
  id: string;
  name: string;
  avatar_type?: "studio_avatar" | "digital_twin" | "photo_avatar" | string;
  group_id?: string | null;
  preview_image_url?: string | null;
  preview_video_url?: string | null;
  gender?: string | null;
  tags?: string[];
  default_voice_id?: string | null;
  supported_api_engines?: string[];
  preferred_orientation?: string | null;
  status?: string | null;
}

export interface HeygenVoice {
  voice_id: string;
  name: string;
  language?: string | null;
  gender?: string | null;
  preview_audio_url?: string | null;
  support_pause?: boolean;
  support_locale?: boolean;
  type?: string;
  default_engine?: string | null;
  available_engines?: string[];
}

export interface ListAvatarLooksQuery extends HeygenPageQuery {
  group_id?: string;
  avatar_type?: "studio_avatar" | "digital_twin" | "photo_avatar";
  ownership?: "public" | "private";
}

export interface ListAvatarGroupsQuery extends HeygenPageQuery {
  ownership?: "public" | "private";
}

export interface ListVoicesQuery extends HeygenPageQuery {
  type?: "public" | "private";
  engine?: string;
  language?: string;
  gender?: string;
}

export interface ListVideoAgentStylesQuery extends HeygenPageQuery {
  tag?: string;
}

// ── Speech ───────────────────────────────────────────────────────────────

export type HeygenSpeechEngine = "starfish" | "orca" | "elevenlabs";

export interface CreateSpeechRequest {
  text: string;
  voice_id: string;
  input_type?: "text" | "ssml";
  speed?: number;
  language?: string;
  locale?: string;
  engine?: HeygenSpeechEngine;
}

export interface CreateSpeechResponse {
  audio_url: string;
  duration: number;
  request_id?: string | null;
  word_timestamps?: unknown[] | null;
  engine: string;
}

// ── Video translation & lipsync ──────────────────────────────────────────

export type HeygenQualityMode = "speed" | "precision";

export interface CreateVideoTranslationRequest {
  video: HeygenAssetInput;
  output_languages: string[];
  /** Custom dubbing audio (url or asset_id). */
  audio?: HeygenAssetInput;
  title?: string;
  mode?: HeygenQualityMode;
  input_language?: string;
  translate_audio_only?: boolean;
  speaker_num?: number;
  keep_the_same_format?: boolean;
  enable_dynamic_duration?: boolean;
  disable_music_track?: boolean;
  enable_speech_enhancement?: boolean;
  start_time?: number;
  end_time?: number;
  brand_glossary_id?: string;
  folder_id?: string;
  callback_url?: string;
  callback_id?: string;
}

export interface CreateVideoTranslationResponse {
  video_translation_ids: string[];
}

export type HeygenTranslationStatus = "pending" | "running" | "completed" | "failed";

export interface HeygenVideoTranslation {
  id: string;
  title?: string | null;
  status: HeygenTranslationStatus | string;
  output_language?: string | null;
  input_language?: string | null;
  duration?: number | null;
  translate_audio_only?: boolean;
  video_url?: string | null;
  audio_url?: string | null;
  srt_caption_url?: string | null;
  vtt_caption_url?: string | null;
  callback_id?: string | null;
  created_at?: number | null;
  failure_message?: string | null;
}

export interface CreateLipsyncRequest {
  video: HeygenAssetInput;
  audio: HeygenAssetInput;
  title?: string;
  mode?: HeygenQualityMode;
  keep_the_same_format?: boolean;
  enable_dynamic_duration?: boolean;
  disable_music_track?: boolean;
  enable_speech_enhancement?: boolean;
  start_time?: number;
  end_time?: number;
  folder_id?: string;
  callback_url?: string;
  callback_id?: string;
}

export interface CreateLipsyncResponse {
  lipsync_id: string;
}

export interface HeygenLipsync {
  id: string;
  title?: string | null;
  status: HeygenTranslationStatus | string;
  duration?: number | null;
  video_url?: string | null;
  caption_url?: string | null;
  callback_id?: string | null;
  created_at?: number | null;
  failure_message?: string | null;
}

// ── HeyGen Video model (POST /v3/models/videos) ──────────────────────────

export type HeygenModelVideoMode = "text_to_video" | "image_to_video" | "reference_to_video";

export interface CreateModelVideoRequest {
  model: string;
  mode: HeygenModelVideoMode;
  prompt: string;
  duration?: number;
  resolution?: "480p" | "768p" | "1080p" | "2k";
  aspect_ratio?: string;
  prompt_enhancement?: "turbo" | "quality" | "disabled";
  seed?: number;
  image?: HeygenAssetInput;
  reference_images?: HeygenAssetInput[];
  reference_videos?: HeygenAssetInput[];
  reference_audio?: HeygenAssetInput[];
  callback_url?: string;
  callback_id?: string;
}

export interface CreateModelVideoResponse {
  video_id: string;
  status: string;
}

export interface HeygenModelVideo {
  video_id: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled" | string;
  model?: string;
  created_at?: number;
  video_url?: string | null;
  duration?: number;
  aspect_ratio?: string;
  width?: number;
  height?: number;
  seed?: number;
  failure_code?: string | null;
  failure_message?: string | null;
}

// ── Assets ───────────────────────────────────────────────────────────────

export interface UploadAssetResponse {
  asset_id: string;
  url: string;
  mime_type: string;
  size_bytes: number;
}
