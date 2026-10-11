/**
 * Atlas Cloud media API types — subset used by multix.
 * Runtime-neutral (no node:* imports) so a Cloudflare Worker can reuse them.
 *
 * Sources: https://www.atlascloud.ai/docs/predictions,
 * https://www.atlascloud.ai/docs/upload-files, https://www.atlascloud.ai/docs/models/audio,
 * and the public catalog at GET https://api.atlascloud.ai/api/v1/models.
 */

import type { FetchLike } from "../../core/fetch-json.js";

/** The three asynchronous submit endpoints. 3D models are served by generateImage. */
export type AtlasMediaKind = "image" | "video" | "audio";

export interface AtlasClientOptions {
  apiKey: string;
  /** Media API base. Defaults to https://api.atlascloud.ai/api/v1 (not the LLM /v1 base). */
  baseUrl?: string;
  /** Injected fetch (Workers, tests). Defaults to globalThis.fetch at call time. */
  fetch?: FetchLike;
  /** Per-request timeout for JSON calls. Default 120s. */
  timeoutMs?: number;
  /** Timeout for uploadMedia. Default 300s (large audio/video uploads are normal). */
  uploadTimeoutMs?: number;
}

/** Every Atlas media response is wrapped as `{ code, msg|message, data }`. */
export interface AtlasEnvelope<T> {
  code?: number;
  msg?: string;
  message?: string;
  data?: T;
}

/**
 * Prediction payload from submit and from GET /model/prediction/{id}.
 * Status values observed and documented: processing, completed, failed; some
 * model schemas also list queued / succeeded.
 */
export interface AtlasPrediction {
  id: string;
  model?: string;
  status: string;
  /** Media URLs, or plain text for speech-to-text / lyrics models. */
  outputs?: unknown[] | null;
  /** Older schemas declare the singular `output`. */
  output?: unknown;
  /** Empty string when there is no error; a string or object otherwise. */
  error?: unknown;
  urls?: { get?: string } | null;
  has_nsfw_contents?: boolean[] | null;
  created_at?: string;
  completed_at?: string;
  price?: string | number;
  latency_ms?: number;
  [key: string]: unknown;
}

/** One entry of the public model catalog (GET /models). */
export interface AtlasCatalogModel {
  model: string;
  type?: string;
  displayName?: string;
  /** URL of the model's OpenAPI document (request schema + submit path). */
  schema?: string;
  categories?: string[];
  tags?: string[];
  display_console?: boolean;
  [key: string]: unknown;
}

export interface AtlasSchemaProperty {
  type?: string;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  items?: { type?: string };
}

/** The parts of a model's OpenAPI document multix needs. */
export interface AtlasModelSpec {
  model: string;
  /** Submit endpoint derived from the schema's path (authoritative over catalog `type`). */
  endpoint?: AtlasMediaKind;
  properties: Record<string, AtlasSchemaProperty>;
  required: string[];
}

export interface AtlasUploadResult {
  url: string;
  filename?: string;
  size?: number;
  type?: string;
}

export interface WaitOptions {
  /** Hard upper bound for the whole wait. */
  timeoutMs: number;
  /** First poll delay. Docs suggest 2s for images, 5s for video. */
  intervalMs?: number;
  maxIntervalMs?: number;
  onPoll?: (prediction: AtlasPrediction, attempt: number) => void;
  /** Appended to the timeout error, e.g. a resume command. */
  resumeHint?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}
