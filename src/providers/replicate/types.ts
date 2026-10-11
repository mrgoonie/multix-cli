/**
 * Replicate HTTP API types — the subset multix uses.
 * https://replicate.com/docs/reference/http
 *
 * Runtime-neutral: no node:* imports, so the client can be reused outside Node
 * (e.g. a Cloudflare Worker).
 */

/**
 * Prediction lifecycle. `canceled` covers user cancels and deadlines reached
 * while running; `aborted` means the prediction was terminated before it started.
 */
export type ReplicateStatus =
  | "starting"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled"
  | "aborted";

export interface ReplicatePrediction {
  id: string;
  status: ReplicateStatus;
  model?: string;
  version?: string;
  /** Model-specific; may be a string, URL list, nested object, or null until finished. */
  output?: unknown;
  error?: unknown;
  logs?: string | null;
  input?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  data_removed?: boolean;
  urls?: { get?: string; cancel?: string; stream?: string; web?: string };
}

export interface ReplicateFile {
  id: string;
  content_type: string;
  size: number;
  expires_at?: string;
  urls: { get: string };
}

/** Where a prediction is created: official model endpoint vs. explicit version. */
export type ModelRef =
  | { kind: "official"; owner: string; name: string }
  | { kind: "version"; version: string; owner?: string; name?: string };
