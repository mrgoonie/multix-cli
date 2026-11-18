/**
 * ToAPIs API shapes (https://docs.toapis.com). Observed against the live API
 * on 2026-11-18: submit returns `{ id, status: "" | "queued" | ... }` and the
 * task query returns `result.data[].url`, `usage` and `billing.cost_usd`.
 */

import type { FetchLike } from "../../core/fetch-json.js";

export type ToapisMediaKind = "image" | "video";
export type ToapisUploadKind = "images" | "videos" | "audios";

export interface ToapisClientOptions {
  apiKey: string;
  /** Default https://toapis.com (https://toapis.cn for mainland China). */
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  uploadTimeoutMs?: number;
}

/** Task status: queued | in_progress | completed | failed (submit may return ""). */
export interface ToapisTask {
  id: string;
  object?: string;
  model?: string;
  status: string;
  progress?: number;
  created_at?: number;
  completed_at?: number;
  expires_at?: number;
  result?: {
    type?: string;
    data?: Array<{
      url?: string;
      fallback_url?: string;
      format?: string;
      last_frame_url?: string;
      background?: string;
    }>;
  };
  usage?: {
    charge_type?: string;
    billed_tokens?: number;
    total_tokens?: number;
    output_seconds?: number;
    requests?: number;
    [key: string]: unknown;
  };
  /** status: pending | settled | refunded. Amounts are decimal strings. */
  billing?: { status?: string; credits?: string; cost_usd?: string };
  error?: {
    code?: string | number | null;
    reason?: string;
    message?: string | number | null;
  };
  generation?: Record<string, unknown>;
}

export interface ToapisModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  supported_endpoint_types?: string[];
}

export interface ToapisUpload {
  id?: string;
  url: string;
  mime_type?: string;
  size?: number;
}

/** One line of the public price quote (`POST /api/sku/quote/batch`, no auth). */
export interface ToapisQuote {
  model: string;
  charge_type: "per_request" | "per_second" | "per_token" | string;
  unit_price: number;
  estimated_price: number;
  display_price: string;
  /** Present for per_token video: ToAPIs' own P75 estimate of USD per output second. */
  estimated_second_price?: { output_unit_price: number; effective_output_unit_price?: number };
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  onPoll?: (task: ToapisTask) => void;
  resumeHint?: string;
}
