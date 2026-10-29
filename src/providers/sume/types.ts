/**
 * Sume API types: the subset multix uses (https://www.sume.com/docs, OpenAPI
 * at https://api.sume.com/reference/json). Catalog rows keep the API's
 * snake_case names so a cached copy compares directly with the live catalog.
 *
 * Runtime-neutral: no node:* imports, so the client can be reused outside Node
 * (e.g. a Cloudflare Worker).
 */

/** `kind` of a catalog row; `image` goes to the image router, the rest to the video router. */
export type SumeKind = "image" | "video" | "lipsync" | "captions";

/** One entry of `request_fields`: the per-model input contract (present on some rows only). */
export interface SumeRequestField {
  required?: boolean;
  /** "string", "integer", "string[]" (absent on some rows). */
  type?: string;
  description?: string;
  min?: number;
  max?: number;
  /** Server-side default; `null` when there is none. */
  default?: string | number | boolean | null;
  options?: string[];
  /** "image", "video" or "audio" for URL inputs. */
  media?: string;
  /** True when the model does not take this field at all. */
  omit?: boolean;
}

export interface SumeCapabilities {
  // video, lipsync, captions
  text_to_video?: boolean;
  image_to_video?: boolean;
  end_frame?: boolean;
  reference_images?: boolean;
  reference_videos?: boolean;
  reference_audios?: boolean;
  video_to_video?: boolean;
  /** The model can make a soundtrack (`generate_audio`). */
  audio?: boolean;
  lipsync?: boolean;
  captions?: boolean;
  dubbing?: boolean;
  video_tool?: string;
  duration_seconds?: { min: number; max: number };
  duration_values?: number[];
  max_reference_images?: number;
  /** Special routes (Sume remix tools) that are not served by the routers. */
  routes?: string[];
  // image
  text_to_image?: boolean;
  image_edit?: boolean;
  qualities?: string[];
  max_images?: number;
  output_formats?: string[];
  // both
  resolutions?: string[];
  aspect_ratios?: string[];
}

export interface SumePriceOption {
  label: string;
  /** Decimal USD per unit, as Sume prints it. */
  usd: string;
  /** Exact USD per unit in millionths. */
  usd_micros: number;
  resolution?: string;
  quality?: string;
  audio?: boolean;
}

export interface SumePricing {
  currency: string;
  /** "second" (video) or "image". */
  unit: string;
  from_usd?: string;
  to_usd?: string;
  options: SumePriceOption[];
}

export interface SumeModel {
  id: string;
  slug?: string;
  name?: string;
  kind: string;
  company?: string;
  description?: string;
  modes: string[];
  capabilities: SumeCapabilities;
  constraints: string[];
  request_fields?: Record<string, SumeRequestField>;
  pricing?: SumePricing;
}

export interface SumeCatalog {
  currency: string;
  models: SumeModel[];
}

/** Lower-case Sume status; unknown strings from a newer API pass through (never terminal). */
export type SumeJobState = "queued" | "processing" | "completed" | "failed" | "canceled";

/** POST /v1/{image,video}-router/generate → data. */
export interface SumeSubmitted {
  jobId: string;
  status: string;
  terminal: boolean;
  cancelable: boolean;
  /** True when Sume returned the job already created for this Idempotency-Key. */
  idempotencyHit: boolean;
  idempotencyKey: string;
  nextPollAfterSeconds?: number;
  /** The charge Sume reserved, in USD rounded up to the cent (a decimal string). */
  usageUsd?: string;
}

/** GET /v1/jobs/{id}/status → data. */
export interface SumeJobStatus {
  jobId: string;
  status: string;
  terminal: boolean;
  resultReady: boolean;
  cancelable: boolean;
  nextPollAfterSeconds?: number;
  queuePosition?: number;
}

export interface SumeArtifact {
  id?: string;
  type?: string;
  url: string;
  contentType?: string;
  sizeBytes?: number;
}

export interface SumeJobError {
  code?: string;
  message?: string;
  publicReason?: string;
}

/** GET /v1/jobs/{id} → data.job (the fields multix reads). */
export interface SumeJob {
  id: string;
  status: string;
  model?: string;
  createdAt?: string;
  error?: SumeJobError;
  /** The job's usage_summary: what Sume holds or charged for it. */
  charge?: SumeJobCharge;
}

/** usage_summary of a job: reserved on submit, then captured (completed) or refunded. */
export interface SumeJobCharge {
  /** reserved | captured | refunded (newer values pass through). */
  status?: string;
  /** captured_usd_cents in USD (0 once refunded). */
  capturedUsd?: number;
}

/** POST /v1/jobs/{id}/cancel → data. */
export interface SumeCancelResult {
  jobId: string;
  status: string;
  canceled: boolean;
  /** True when the job had already been canceled. */
  alreadyCanceled: boolean;
}

/** POST /v1/files/generate-upload-url → data. */
export interface SumeUploadTicket {
  public_url: string;
  upload_url: string;
  upload_method: string;
  upload_headers: Record<string, string>;
  expires_at?: string;
  asset_id?: string;
}

/** GET /v1/open/balance → data (USD). */
export interface SumeBalance {
  balance?: number;
  currency?: string;
  usage_this_month?: number;
  balance_usd_micros?: number;
}
