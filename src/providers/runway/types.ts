/**
 * Runway API types — the subset multix uses (API version 2024-11-06).
 * https://docs.dev.runwayml.com/api/
 *
 * Runtime-neutral: no node:* imports, so the client can be reused outside Node
 * (e.g. a Cloudflare Worker).
 */

export type RunwayTaskStatus =
  | "PENDING"
  | "THROTTLED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export interface RunwayCredits {
  credits: number;
}

export interface RunwayTask {
  id: string;
  status: RunwayTaskStatus;
  createdAt?: string;
  /** 0–1 while RUNNING. */
  progress?: number;
  /** Maximum credits while nonterminal. */
  estimatedCost?: RunwayCredits;
  /** Final credits once terminal (0 when fully refunded). */
  cost?: RunwayCredits;
  /** SUCCEEDED: signed output URLs that expire within 24–48 hours. */
  output?: string[];
  /** FAILED: human-readable reason and machine-readable code. */
  failure?: string;
  failureCode?: string;
}

/** Response of every create endpoint. */
export interface RunwayCreatedTask {
  id: string;
  /** Maximum credits the task may charge; the final amount may be lower. */
  estimatedCost?: RunwayCredits;
}

export interface RunwayPromptImage {
  uri: string;
  position: "first";
}

export interface RunwayReferenceImage {
  uri: string;
  tag?: string;
}

export interface ImageToVideoRequest {
  model: string;
  promptImage: string | RunwayPromptImage[];
  promptText?: string;
  ratio: string;
  duration?: number;
  seed?: number;
}

export interface TextToVideoRequest {
  model: string;
  promptText: string;
  ratio: string;
  duration: number;
  seed?: number;
}

export interface TextToImageRequest {
  model: string;
  promptText: string;
  ratio: string;
  referenceImages?: RunwayReferenceImage[];
  seed?: number;
}

/** POST /v1/uploads: a presigned form upload whose result is a runway:// URI. */
export interface RunwayUploadTicket {
  uploadUrl: string;
  fields: Record<string, string>;
  runwayUri: string;
}
