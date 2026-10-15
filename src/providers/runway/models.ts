/**
 * Runway API (Runway Dev) routing, model registry, and task helpers.
 * Runtime-neutral: no node:* imports and no env access — callers resolve env
 * overrides (RUNWAY_VIDEO_MODEL / RUNWAY_IMAGE_MODEL) themselves.
 *
 * Only Runway's own Gen-4 family is supported here, with the request limits of
 * the published OpenAPI spec (API version 2024-11-06, checked 2026-10-15). The
 * Runway API also serves third-party models with other schemas; those are not
 * interchangeable and are rejected rather than sent unchecked.
 */

import { ValidationError } from "../../core/errors.js";
import type { RunwayTaskStatus } from "./types.js";

export const DEFAULT_RUNWAY_BASE_URL = "https://api.dev.runwayml.com";

/** Sent as X-Runway-Version on every request (the only version the API accepts today). */
export const RUNWAY_API_VERSION = "2024-11-06";

/**
 * Base URL override and the key env name. Shared by the key lookup, the base
 * URL trust check and `multix check`, so the three cannot drift apart.
 */
export const RUNWAY_ROUTING = {
  name: "RUNWAY_BASE_URL",
  defaultUrl: DEFAULT_RUNWAY_BASE_URL,
  keyEnvs: ["RUNWAYML_API_SECRET"],
} as const;

/** Developer portal: API keys, credits, and usage. */
export const RUNWAY_DASHBOARD_LINK = "https://dev.runwayml.com/";
export const RUNWAY_PRICING_LINK = "https://docs.dev.runwayml.com/guides/pricing/";

/** One credit costs $0.01 (Runway API pricing). */
export const USD_PER_CREDIT = 0.01;

export const DEFAULT_RUNWAY_VIDEO_MODEL = "gen4.5";
export const DEFAULT_RUNWAY_IMAGE_MODEL = "gen4_image";
export const DEFAULT_VIDEO_RATIO = "1280:720";
export const DEFAULT_IMAGE_RATIO = "1280:720";
export const DEFAULT_VIDEO_DURATION = 5;

/** promptText: non-empty, up to 1000 UTF-16 code units. */
export const PROMPT_MAX_LENGTH = 1000;
export const SEED_MAX = 4_294_967_295;

const I2V_RATIOS = ["1280:720", "720:1280", "1104:832", "832:1104", "960:960", "1584:672"];

export interface VideoModelSpec {
  /** Text-to-video ratios; absent when the model needs a first-frame image. */
  textRatios?: readonly string[];
  imageRatios: readonly string[];
  minDuration: number;
  maxDuration: number;
  /** Prompt text is required (gen4.5) or optional (gen4_turbo image-to-video). */
  promptRequired: boolean;
  /** Indicative list price, for the pre-submit estimate only. */
  creditsPerSecond: number;
}

export const VIDEO_MODELS: Readonly<Record<string, VideoModelSpec>> = {
  "gen4.5": {
    textRatios: ["1280:720", "720:1280"],
    imageRatios: I2V_RATIOS,
    minDuration: 2,
    maxDuration: 10,
    promptRequired: true,
    creditsPerSecond: 12,
  },
  gen4_turbo: {
    imageRatios: I2V_RATIOS,
    minDuration: 2,
    maxDuration: 10,
    promptRequired: false,
    creditsPerSecond: 5,
  },
};

const IMAGE_RATIOS = [
  "1024:1024",
  "1080:1080",
  "1168:880",
  "1360:768",
  "1440:1080",
  "1080:1440",
  "1808:768",
  "1920:1080",
  "1080:1920",
  "2112:912",
  "1280:720",
  "720:1280",
  "720:720",
  "960:720",
  "720:960",
  "1680:720",
];

export interface ImageModelSpec {
  ratios: readonly string[];
  minReferences: number;
  maxReferences: number;
  /** Indicative list price per image ("from" price when it varies by resolution). */
  credits: number;
  creditsVary: boolean;
}

export const IMAGE_MODELS: Readonly<Record<string, ImageModelSpec>> = {
  gen4_image: {
    ratios: IMAGE_RATIOS,
    minReferences: 0,
    maxReferences: 3,
    credits: 5,
    creditsVary: true,
  },
  gen4_image_turbo: {
    ratios: IMAGE_RATIOS,
    minReferences: 1,
    maxReferences: 3,
    credits: 2,
    creditsVary: false,
  },
};

function unknownModel(kind: string, model: string, known: Record<string, unknown>): never {
  throw new ValidationError(
    `Unsupported Runway ${kind} model "${model}". Supported: ${Object.keys(known).join(", ")}`,
  );
}

export function videoModelSpec(model: string): VideoModelSpec {
  return VIDEO_MODELS[model] ?? unknownModel("video", model, VIDEO_MODELS);
}

export function imageModelSpec(model: string): ImageModelSpec {
  return IMAGE_MODELS[model] ?? unknownModel("image", model, IMAGE_MODELS);
}

/** Throw unless the prompt is non-empty and within PROMPT_MAX_LENGTH UTF-16 code units. */
export function assertPromptText(prompt: string): string {
  if (!prompt.trim()) throw new ValidationError("Prompt must not be empty");
  if (prompt.length > PROMPT_MAX_LENGTH) {
    throw new ValidationError(
      `Prompt is ${prompt.length} characters; Runway accepts up to ${PROMPT_MAX_LENGTH}`,
    );
  }
  return prompt;
}

/** Parse a seed in 0..4294967295. */
export function parseSeed(raw: string): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n > SEED_MAX) {
    throw new ValidationError(`--seed must be an integer from 0 to ${SEED_MAX}`);
  }
  return n;
}

/** `credits (~$x.xx)` for log lines. */
export function formatCredits(credits: number): string {
  return `${credits} credits (~$${(credits * USD_PER_CREDIT).toFixed(2)})`;
}

export const TERMINAL_STATUSES: readonly RunwayTaskStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED"];

export function isTerminalStatus(status: string | undefined): boolean {
  return TERMINAL_STATUSES.includes(status as RunwayTaskStatus);
}

/** Runway task ids are UUIDs (v4). */
const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a UUID task id (safe in URL paths, file names, and printed commands). */
export function isValidTaskId(id: unknown): id is string {
  return typeof id === "string" && TASK_ID_RE.test(id);
}

/** Reject anything but a UUID so a task id can never alter the request path. */
export function assertTaskId(id: string): string {
  const trimmed = id.trim();
  if (!TASK_ID_RE.test(trimmed)) {
    throw new ValidationError(`Invalid Runway task id "${id}" — expected a UUID`);
  }
  return trimmed.toLowerCase();
}
