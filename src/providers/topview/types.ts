/**
 * TopView API types, the subset multix reads. Runtime-neutral (no node:* imports).
 * Sources: https://docs.topview.ai/llms.txt (legacy API) and
 * https://platform.topview.ai/llms-full.txt (API Platform).
 */

import type { FetchLike } from "../../core/fetch-json.js";

/** Legacy responses: `{ code: "200", message, result }`; `code` is a string. */
export interface LegacyEnvelope<T> {
  code?: string | number;
  message?: string;
  result?: T;
}

/** A legacy task as its query endpoint returns it; fields vary by task kind. */
export interface LegacyTask {
  taskId: string;
  /** init | running | success | fail */
  status: string;
  errorMsg?: string | null;
  /** Credits the task consumed, when the endpoint reports it. */
  costCredit?: number;
  [key: string]: unknown;
}

export interface LegacyClientOptions {
  apiKey: string;
  uid: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Per-request timeout. Default 120 s. */
  timeoutMs?: number;
}

export interface LegacyUploadCredential {
  fileId: string;
  uploadUrl: string;
  fileName?: string;
  format?: string;
}

/** Platform responses: `{ code, message, data }`; `code` is an integer. */
export interface PlatformEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

export type PlatformStatus = "created" | "processing" | "payment_required" | "completed" | "failed";

export interface PlatformPrediction {
  id: string;
  status: string;
  outputs?: string[];
  /** Exact decimal string; the actual charge, not the reservation. */
  charged_usd?: string;
  /** RESERVED (a hold, not spend) | CAPTURED (final) | RELEASED (hold returned). */
  billing_state?: string;
  amount_due_usd?: string;
  additional_charge_usd?: string;
  shortfall_usd?: string;
  error?: string;
  created_at?: string;
  execution_state?: string;
  last_frame_url?: string;
  [key: string]: unknown;
}

export interface PlatformAsset {
  id: string;
  kind?: string;
  reference?: string;
  content_type?: string;
  size?: number;
  /** Temporary signed URL: never logged. */
  download_url?: string;
  display_name?: string | null;
}

export interface PlatformClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface WaitOptions<T> {
  timeoutMs: number;
  intervalMs?: number;
  maxIntervalMs?: number;
  onPoll?: (state: T, attempt: number) => void;
  resumeHint?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}
