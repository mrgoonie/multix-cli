/**
 * Runway Dev API types — the subset multix uses.
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

/** Response of every create endpoint. */
export interface RunwayCreatedTask {
  id: string;
  /** The maximum credits the task may charge; the final amount may be lower. */
  estimatedCost?: RunwayCredits;
}

export interface RunwayTask {
  id: string;
  status: RunwayTaskStatus;
  createdAt?: string;
  /** 0-1 while RUNNING. */
  progress?: number;
  /** Before a terminal status: the most the task may charge. */
  estimatedCost?: RunwayCredits;
  /** After a terminal status: what was charged (0 when fully refunded). */
  cost?: RunwayCredits;
  /** SUCCEEDED: signed URLs that expire within 24-48 hours. */
  output?: string[];
  /** FAILED: human-readable reason. */
  failure?: string;
  /** FAILED: machine-readable code (https://docs.dev.runwayml.com/errors/task-failures/). */
  failureCode?: string;
}

export interface RunwayPromptImage {
  uri: string;
  position: "first";
}

export interface RunwayContentModeration {
  publicFigureThreshold?: "auto" | "low";
}

/** POST /v1/text_to_video (Gen-4.5). */
export interface RunwayTextToVideoBody {
  model: string;
  promptText: string;
  ratio: string;
  duration: number;
  seed?: number;
  contentModeration?: RunwayContentModeration;
}

/** POST /v1/image_to_video (Gen-4.5, Gen-4 Turbo). */
export interface RunwayImageToVideoBody {
  model: string;
  promptImage: string | RunwayPromptImage[];
  promptText?: string;
  ratio: string;
  duration: number;
  seed?: number;
  contentModeration?: RunwayContentModeration;
}

export interface RunwayReferenceImage {
  uri: string;
  tag?: string;
}

/** POST /v1/text_to_image (Gen-4 Image, Gen-4 Image Turbo). */
export interface RunwayTextToImageBody {
  model: string;
  promptText: string;
  ratio: string;
  referenceImages?: RunwayReferenceImage[];
  seed?: number;
  contentModeration?: RunwayContentModeration;
}

/** POST /v1/uploads response: a pre-signed form upload, then the runway:// URI to use. */
export interface RunwayUploadSlot {
  uploadUrl: string;
  fields: Record<string, string>;
  runwayUri: string;
}
