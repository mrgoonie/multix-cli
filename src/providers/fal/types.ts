/**
 * fal.ai queue REST API types — subset used by multix CLI.
 * https://docs.fal.ai/model-endpoints/queue
 */

export interface FalSubmitResponse {
  request_id: string;
  status_url: string;
  response_url: string;
  cancel_url?: string;
  queue_position?: number;
}

export type FalQueueStatus = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";

export interface FalStatusResponse {
  status: FalQueueStatus;
  request_id?: string;
  queue_position?: number;
  logs?: Array<{ message: string; timestamp?: string }>;
  metrics?: { inference_time?: number };
  response_url?: string;
}

/** Result shape is model-specific; the CLI extracts known media-URL fields generically. */
export type FalResultResponse = Record<string, unknown>;
