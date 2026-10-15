/**
 * Runway Dev API constants, the supported-model registry and validators.
 * Runtime-neutral: no node:* imports and no env access — callers resolve env
 * overrides (RUNWAY_VIDEO_MODEL / RUNWAY_IMAGE_MODEL) themselves.
 *
 * Only Runway's own Gen-4 family is supported. Runway Dev also resells many
 * third-party models with different schemas and prices; an unknown model id
 * is refused before any chargeable request instead of being passed through.
 * Ratios and durations mirror the official API reference (checked
 * 2026-10-15, @runwayml/sdk 4.22.0); prices are never hardcoded — the API
 * returns the estimated cost of each task when it is created.
 */

import { ValidationError } from "../../core/errors.js";
import type { RunwayTaskStatus } from "./types.js";

export const DEFAULT_RUNWAY_BASE_URL = "https://api.dev.runwayml.com";
/** Sent as X-Runway-Version on every request (https://docs.dev.runwayml.com/api-details/versioning/). */
export const RUNWAY_API_VERSION = "2024-11-06";

/**
 * Base URL override and the key env name, shared by the key lookup, the base
 * URL trust check and `multix check`, so the three cannot drift apart.
 */
export const RUNWAY_ROUTING = {
  name: "RUNWAY_BASE_URL",
  defaultUrl: DEFAULT_RUNWAY_BASE_URL,
  keyEnvs: ["RUNWAYML_API_SECRET"],
} as const;

export const RUNWAY_KEY_LINK = "https://dev.runwayml.com/";
export const RUNWAY_TASKS_DASHBOARD = "https://dev.runwayml.com/";
/** One Runway credit costs $0.01 (https://docs.dev.runwayml.com/guides/pricing/). */
export const USD_PER_CREDIT = 0.01;

export const DEFAULT_RUNWAY_VIDEO_MODEL = "gen4.5";
export const DEFAULT_RUNWAY_IMAGE_MODEL = "gen4_image";
export const DEFAULT_RUNWAY_VIDEO_RATIO = "1280:720";
export const DEFAULT_RUNWAY_IMAGE_RATIO = "1280:720";
export const DEFAULT_RUNWAY_DURATION = 5;

export interface RunwayVideoModel {
  id: string;
  label: string;
  /** Text-to-video without a first-frame image. */
  textToVideo: boolean;
  /** Ratios accepted with a prompt image (image_to_video). */
  imageRatios: readonly string[];
  /** Ratios accepted without one (text_to_video); empty when unsupported. */
  textRatios: readonly string[];
  minDuration: number;
  maxDuration: number;
  /** Image-to-video requires prompt text. */
  promptRequired: boolean;
}

export interface RunwayImageModel {
  id: string;
  label: string;
  ratios: readonly string[];
  /** Minimum number of reference images. */
  minReferences: number;
  maxReferences: number;
}

const GEN4_VIDEO_RATIOS = ["1280:720", "720:1280", "1104:832", "832:1104", "960:960", "1584:672"];

const GEN4_IMAGE_RATIOS = [
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

export const RUNWAY_VIDEO_MODELS: readonly RunwayVideoModel[] = [
  {
    id: "gen4.5",
    label: "Gen-4.5 (text-to-video and image-to-video)",
    textToVideo: true,
    imageRatios: GEN4_VIDEO_RATIOS,
    textRatios: ["1280:720", "720:1280"],
    minDuration: 2,
    maxDuration: 10,
    promptRequired: true,
  },
  {
    id: "gen4_turbo",
    label: "Gen-4 Turbo (image-to-video only)",
    textToVideo: false,
    imageRatios: GEN4_VIDEO_RATIOS,
    textRatios: [],
    minDuration: 2,
    maxDuration: 10,
    promptRequired: false,
  },
];

export const RUNWAY_IMAGE_MODELS: readonly RunwayImageModel[] = [
  {
    id: "gen4_image",
    label: "Gen-4 Image (text-to-image, up to 3 reference images)",
    ratios: GEN4_IMAGE_RATIOS,
    minReferences: 0,
    maxReferences: 3,
  },
  {
    id: "gen4_image_turbo",
    label: "Gen-4 Image Turbo (needs 1-3 reference images)",
    ratios: GEN4_IMAGE_RATIOS,
    minReferences: 1,
    maxReferences: 3,
  },
];

function unknownModel(kind: string, id: string, known: readonly { id: string }[]): never {
  throw new ValidationError(
    `Unsupported Runway ${kind} model "${id}". Supported: ${known.map((m) => m.id).join(", ")}`,
  );
}

export function getVideoModel(id: string): RunwayVideoModel {
  return (
    RUNWAY_VIDEO_MODELS.find((m) => m.id === id.trim()) ??
    unknownModel("video", id, RUNWAY_VIDEO_MODELS)
  );
}

export function getImageModel(id: string): RunwayImageModel {
  return (
    RUNWAY_IMAGE_MODELS.find((m) => m.id === id.trim()) ??
    unknownModel("image", id, RUNWAY_IMAGE_MODELS)
  );
}

/** Prompt text: non-empty, at most 1000 UTF-16 code units. */
export const PROMPT_MAX_LENGTH = 1000;

export function validatePromptText(
  prompt: string | undefined,
  required: boolean,
): string | undefined {
  const text = prompt?.trim() ?? "";
  if (!text) {
    if (required) throw new ValidationError("Prompt must not be empty");
    return undefined;
  }
  if (text.length > PROMPT_MAX_LENGTH) {
    throw new ValidationError(
      `Prompt is ${text.length} characters; Runway accepts at most ${PROMPT_MAX_LENGTH}`,
    );
  }
  return text;
}

/** Validate --duration for a video model: an integer within the model's range. */
export function validateDuration(model: RunwayVideoModel, raw: string | number): number {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < model.minDuration || n > model.maxDuration) {
    throw new ValidationError(
      `--duration for ${model.id} must be an integer from ${model.minDuration} to ${model.maxDuration} seconds`,
    );
  }
  return n;
}

export function validateVideoRatio(
  model: RunwayVideoModel,
  ratio: string,
  withImage: boolean,
): string {
  const allowed = withImage ? model.imageRatios : model.textRatios;
  if (!allowed.includes(ratio)) {
    const mode = withImage ? "image-to-video" : "text-to-video";
    throw new ValidationError(
      `--ratio ${ratio} is not supported by ${model.id} ${mode}. Use one of: ${allowed.join(", ")}`,
    );
  }
  return ratio;
}

export function validateImageRatio(model: RunwayImageModel, ratio: string): string {
  if (!model.ratios.includes(ratio)) {
    throw new ValidationError(
      `--ratio ${ratio} is not supported by ${model.id}. Use one of: ${model.ratios.join(", ")}`,
    );
  }
  return ratio;
}

/** Seeds are non-negative 32-bit integers. */
export const SEED_MAX = 4_294_967_295;

export function validateSeed(raw: string): number {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0 || n > SEED_MAX) {
    throw new ValidationError(`--seed must be an integer from 0 to ${SEED_MAX}`);
  }
  return n;
}

const TAG_RE = /^[A-Za-z][A-Za-z0-9_]{2,15}$/;

/** Reference image tags: 3-16 characters, start with a letter, letters/digits/underscores only. */
export function validateReferenceTag(tag: string): string {
  if (!TAG_RE.test(tag)) {
    throw new ValidationError(
      `Invalid reference tag "${tag}": use 3-16 letters, digits or underscores, starting with a letter`,
    );
  }
  return tag;
}

export const PUBLIC_FIGURE_THRESHOLDS = ["auto", "low"] as const;
export type PublicFigureThreshold = (typeof PUBLIC_FIGURE_THRESHOLDS)[number];

export function validatePublicFigureThreshold(raw: string): PublicFigureThreshold {
  if (!(PUBLIC_FIGURE_THRESHOLDS as readonly string[]).includes(raw)) {
    throw new ValidationError(
      `--public-figure-threshold must be one of: ${PUBLIC_FIGURE_THRESHOLDS.join(", ")}`,
    );
  }
  return raw as PublicFigureThreshold;
}

export const TERMINAL_STATUSES: readonly RunwayTaskStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED"];
export const KNOWN_STATUSES: readonly RunwayTaskStatus[] = [
  "PENDING",
  "THROTTLED",
  "RUNNING",
  ...TERMINAL_STATUSES,
];

export function isTerminalStatus(status: string | undefined): boolean {
  return TERMINAL_STATUSES.includes(status as RunwayTaskStatus);
}

/** Task ids are UUIDs; accept only characters that are safe in URL paths, file names and shells. */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

export function isValidTaskId(id: unknown): id is string {
  return typeof id === "string" && TASK_ID_RE.test(id);
}

export function assertTaskId(id: string): string {
  const trimmed = id.trim();
  if (!TASK_ID_RE.test(trimmed)) throw new ValidationError(`Invalid Runway task id "${id}"`);
  return trimmed;
}

/** "60 credits (≈ $0.60)" — credits come from the API, the dollar figure from the fixed credit price. */
export function formatCredits(credits: number): string {
  const usd = (credits * USD_PER_CREDIT).toFixed(2);
  return `${credits} credits (≈ $${usd})`;
}
