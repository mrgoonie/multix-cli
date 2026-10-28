/**
 * Sume API types — the subset multix uses. Shapes follow the live OpenAPI
 * (`/v1/openapi.json`, "Sume Developer API 1.0.0") and the docs at
 * https://www.sume.com/docs; every field the client reads is checked at
 * runtime, since the API is young and its docs and schema disagree in places.
 *
 * Runtime-neutral: no node:* imports.
 */

export type SumeJobStatus = "queued" | "processing" | "completed" | "failed" | "canceled";

/** `job.usage_summary`: credits plus USD in whole cents. */
export interface SumeUsageSummary {
  status?: string;
  reserved_usd_cents?: number;
  captured_usd_cents?: number;
  refunded_usd_cents?: number;
  released_usd_cents?: number;
  final?: boolean;
}

/** `job.error` of a failed or canceled job. */
export interface SumeJobError {
  code?: string;
  message?: string;
  public_reason?: string;
  retryable?: boolean;
}

/** Normalized job state from a submit, status or full-job response. */
export interface SumeJob {
  id: string;
  status: SumeJobStatus;
  terminal: boolean;
  model?: string;
  createdAt?: string;
  cancelable?: boolean;
  /** Seconds the API asks the client to wait before the next status read. */
  nextPollAfterSeconds?: number;
  queuePosition?: number;
  error?: SumeJobError;
  usageSummary?: SumeUsageSummary;
}

/** Submit response (202, or 200 for a sync/idempotent replay). */
export interface SumeSubmitted {
  job: SumeJob;
  /** The charge reserved at submit, a decimal USD string rounded up to the cent. */
  usageUsd?: string;
  /** True when the Idempotency-Key matched an earlier submission (charged once). */
  idempotencyHit: boolean;
  idempotencyKey: string;
}

export interface SumeArtifact {
  id?: string;
  type?: string;
  url: string;
  content_type?: string | null;
  size_bytes?: number | null;
}

export interface SumeResult {
  jobId: string;
  artifacts: SumeArtifact[];
}

export interface SumeCancelResult {
  jobId: string;
  canceled: boolean;
  idempotencyHit: boolean;
  status?: string;
  message?: string;
}

/** `POST /v1/files/generate-upload-url` 201 `data`. */
export interface SumeUploadTicket {
  public_url: string;
  upload_url: string;
  upload_method: string;
  upload_headers: Record<string, string>;
  asset_id?: string;
  expires_at?: string;
}

/** `POST /v1/open/estimate` 200 `data`. */
export interface SumeEstimate {
  model: string;
  currency: string;
  usd: string;
  usd_micros?: number;
  route?: string;
  billing?: {
    unit?: string;
    quantity?: number;
    duration_seconds?: number | null;
    resolution?: string | null;
  };
}

/** Request body for both routers: typed fields plus any extra `--input` fields. */
export type SumeRequestBody = { model: string } & Record<string, unknown>;
