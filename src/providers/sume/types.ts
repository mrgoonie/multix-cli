/**
 * Sume REST API types — the subset multix uses.
 * Runtime-neutral (no node:* imports) so a Cloudflare Worker can reuse them.
 *
 * Sources: https://www.sume.com/docs (jobs, errors, uploads, images, video),
 * the OpenAPI document at https://api.sume.com/reference/json and the public
 * catalog at GET https://api.sume.com/v1/open/catalog.
 */

import type { FetchLike } from "../../core/fetch-json.js";

/** The two generate routers multix submits to. */
export type SumeRouter = "image" | "video";

export interface SumeClientOptions {
  apiKey: string;
  /** Defaults to https://api.sume.com. */
  baseUrl?: string;
  /** Injected fetch (Workers, tests). Defaults to globalThis.fetch at call time. */
  fetch?: FetchLike;
  /** Per-request timeout for JSON calls. Default 120 s. */
  timeoutMs?: number;
  /** Timeout for an upload PUT. Default 600 s. */
  uploadTimeoutMs?: number;
}

/** One price row of a catalog model (`pricing.options[]`). */
export interface SumePriceOption {
  label?: string;
  usd?: string;
  usd_micros?: number;
  route?: string;
  resolution?: string;
  quality?: string;
  audio?: boolean;
}

export interface SumePricing {
  currency?: string;
  /** "image" or "second". */
  unit?: string;
  from_usd?: string;
  to_usd?: string;
  qualifier?: string;
  options?: SumePriceOption[];
}

/** A field the catalog says a model takes, needs or refuses (`request_fields`). */
export interface SumeRequestField {
  required?: boolean;
  omit?: boolean;
  type?: string;
  min?: number;
  max?: number;
  options?: unknown[];
  default?: unknown;
  description?: string;
}

/** Capabilities as published; every field is optional because kinds differ. */
export interface SumeCapabilities {
  text_to_image?: boolean;
  image_edit?: boolean;
  qualities?: string[];
  max_images?: number;
  output_formats?: string[];
  text_to_video?: boolean;
  image_to_video?: boolean;
  end_frame?: boolean;
  reference_images?: boolean;
  reference_videos?: boolean;
  reference_audios?: boolean;
  video_to_video?: boolean;
  audio?: boolean;
  lipsync?: boolean;
  captions?: boolean;
  resolutions?: string[];
  aspect_ratios?: string[];
  duration_seconds?: { min?: number; max?: number };
  duration_values?: number[];
  max_reference_images?: number;
  /** Models served by their own route instead of the generate routers. */
  routes?: string[];
  [key: string]: unknown;
}

export interface SumeCatalogModel {
  id: string;
  slug?: string;
  name?: string;
  /** image | video | lipsync | captions */
  kind?: string;
  description?: string;
  modes?: string[];
  pricing?: SumePricing;
  capabilities?: SumeCapabilities;
  constraints?: string[];
  request_fields?: Record<string, SumeRequestField>;
  company?: { slug?: string; name?: string };
}

/** `job.usage_summary`: the reservation ledger of one job. */
export interface SumeUsageSummary {
  status?: "reserved" | "captured" | "refunded" | string;
  reserved_credits?: number;
  captured_credits?: number;
  refunded_credits?: number;
  released_credits?: number;
  reserved_usd_cents?: number;
  captured_usd_cents?: number;
  refunded_usd_cents?: number;
  released_usd_cents?: number;
  final?: boolean;
  updated_at?: string;
}

export interface SumeJobError {
  code?: string;
  message?: string;
  public_reason?: string;
  request_id?: string;
}

/** Lower-case job state (`sume_status`, and `job.status`). */
export type SumeJobState = "queued" | "processing" | "completed" | "failed" | "canceled";

export interface SumeJob {
  id: string;
  type?: string;
  status?: SumeJobState | string;
  model?: string;
  idempotency_key?: string;
  created_at?: string;
  error?: SumeJobError | null;
  usage_summary?: SumeUsageSummary | null;
}

/** `data` of a 202 from either generate router. */
export interface SumeSubmitResult {
  request_id?: string;
  job: SumeJob;
  status_url?: string;
  result_url?: string;
  cancel_url?: string | null;
  cancelable?: boolean;
  next_poll_after_seconds?: number | null;
  terminal?: boolean;
  idempotency_hit?: boolean;
  /** The charge the reservation holds; a hold, not a settled spend. */
  usage?: { credits?: number; usd?: string };
}

/** `data` of GET /v1/jobs/{id}/status. */
export interface SumeJobStatus {
  job_id: string;
  /** IN_QUEUE | IN_PROGRESS | COMPLETED | FAILED | CANCELED */
  status?: string;
  sume_status?: SumeJobState | string;
  terminal?: boolean;
  result_ready?: boolean;
  next_action?: string;
  next_poll_after_seconds?: number | null;
  cancelable?: boolean;
  error?: SumeJobError | null;
}

export interface SumeArtifact {
  id?: string;
  type?: string;
  url: string;
  content_type?: string;
  size_bytes?: number;
  width?: number;
  height?: number;
  duration_ms?: number;
}

/** `data` of GET /v1/jobs/{id}/result. */
export interface SumeJobResult {
  job_id?: string;
  status?: string;
  artifacts: SumeArtifact[];
  job?: SumeJob;
}

/** `data` of POST /v1/jobs/{id}/cancel. */
export interface SumeCancelResult {
  job_id?: string;
  status?: string;
  canceled?: boolean;
  job?: SumeJob;
}

/** `data` of POST /v1/open/estimate. */
export interface SumeEstimate {
  model?: string;
  currency?: string;
  usd?: string;
  usd_micros: number;
  route?: string;
  billing?: {
    unit?: string;
    quantity?: number;
    duration_seconds?: number | null;
    resolution?: string | null;
  };
}

/** `data` of POST /v1/files/generate-upload-url. */
export interface SumeUploadTarget {
  public_url: string;
  /** Pre-signed: a secret, never logged. */
  upload_url: string;
  upload_method?: string;
  upload_headers?: Record<string, string>;
  asset_id?: string;
  expires_at?: string;
}

export interface SumeWaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  maxIntervalMs?: number;
  onPoll?: (status: SumeJobStatus, attempt: number) => void;
  resumeHint?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}
