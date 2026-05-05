/**
 * BytePlus ModelArk API types — subset used by multix CLI.
 * Image: OpenAI-compat /images/generations.
 * Video: ARK async tasks /contents/generations/tasks.
 */

export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  image?: string[];
  size?: string;
  response_format?: "url" | "b64_json";
  watermark?: boolean;
  seed?: number;
  n?: number;
}

export interface ImageDataItem {
  url?: string;
  b64_json?: string;
  size?: string;
  seed?: number;
}

export interface ImageGenerationResponse {
  data: ImageDataItem[];
  model?: string;
  created?: number;
  usage?: Record<string, unknown>;
}

export type VideoContentItem =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; role?: string } }
  | { type: "video_url"; video_url: { url: string; role?: string } }
  | { type: "audio_url"; audio_url: { url: string; role?: string } };

export interface VideoTaskParameters {
  resolution?: string;
  duration?: number;
  aspect_ratio?: string;
  audio?: boolean;
  seed?: number;
  negative_prompt?: string;
  camera_fixed?: boolean;
}

export interface VideoTaskRequest {
  model: string;
  content: VideoContentItem[];
  parameters?: VideoTaskParameters;
}

export interface VideoTaskResponse {
  id: string;
  [k: string]: unknown;
}

export type VideoTaskState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | string;

export interface VideoTaskStatus {
  id: string;
  status: VideoTaskState;
  model?: string;
  content?: {
    video_url?: string;
    [k: string]: unknown;
  };
  error?: { code?: string; message?: string };
  created_at?: number;
  updated_at?: number;
  [k: string]: unknown;
}

export type RefKind = "image" | "video" | "audio";

export interface ResolvedRef {
  kind: RefKind;
  url: string;
  mime?: string;
  role?: string;
}

/**
 * 3D generation task — Hyper3D / Hitem3d on the same async tasks endpoint.
 *   POST /contents/generations/tasks → { id }
 *   GET  /contents/generations/tasks/{id} → status + content.file_url
 * Body shape: { model, content: [{type:"text",text}, {type:"image_url",image_url:{url}}…], seed? }
 * Provider-specific flags (e.g. --mesh_mode, --resolution) are appended to content[0].text.
 */
export interface Model3DTaskRequest {
  model: string;
  content: VideoContentItem[];
  seed?: number;
}

export interface Model3DTaskStatus {
  id: string;
  status: VideoTaskState;
  model?: string;
  content?: {
    file_url?: string;
    [k: string]: unknown;
  };
  error?: { code?: string; message?: string };
  usage?: { completion_tokens?: number; total_tokens?: number; [k: string]: unknown };
  created_at?: number;
  updated_at?: number;
  [k: string]: unknown;
}
