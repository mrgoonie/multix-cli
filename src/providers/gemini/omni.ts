/**
 * Gemini Omni Flash video generation and editing over the Interactions API.
 * Contract (https://ai.google.dev/gemini-api/docs/omni, checked against the
 * live GA API for gemini-omni-1.1-flash):
 *   POST /v1beta/interactions
 *     { model, input: string | content parts, previous_interaction_id?, store, background,
 *       response_format: { type: "video", delivery, aspect_ratio, resolution, duration: "<n>s" },
 *       generation_config?: { video_config: { task } } }
 *   GET  /v1beta/interactions/{id} until `status` leaves in_progress/queued
 *   The video is a `{ type: "video", uri | data, mime_type }` part in the
 *   `model_output` step of `steps[]`. `output_video` is an SDK convenience,
 *   never part of the REST resource. A `uri` is a Files API file
 *   (`files/<id>`, PROCESSING → ACTIVE | FAILED) downloaded with the API key.
 *
 * Runtime-neutral: no node:* imports, env or disk access. HTTP goes through
 * client.ts; the CLI flow (key choice, polling, files on disk) is omni-flow.ts.
 */

import { ValidationError } from "../../core/errors.js";

export const OMNI_ASPECT_RATIOS = ["16:9", "9:16"] as const;
export const OMNI_RESOLUTIONS = ["360p", "720p", "1080p", "4k"] as const;
export const OMNI_MIN_DURATION_SECONDS = 3;
export const OMNI_MAX_DURATION_SECONDS = 10;
export const OMNI_DEFAULT_RESOLUTION = "720p";
export const OMNI_DEFAULT_ASPECT_RATIO = "16:9";

/** Image types the Omni docs list for image inputs. */
export const OMNI_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
  "image/bmp",
  "image/tiff",
]);

/**
 * Paid-tier list prices in USD per 1M tokens (ai.google.dev/gemini-api/docs/pricing,
 * October 2026). Thought tokens are billed as text output. Used only for a
 * labelled estimate; the bill is what Google reports.
 */
export const OMNI_PRICE_PER_M_TOKENS = { input: 1.5, textOutput: 9, videoOutput: 17.5 } as const;

/** `generation_config.video_config.task` values; omitted, the model infers the task. */
export type OmniVideoTask =
  | "text_to_video"
  | "image_to_video"
  | "reference_to_video"
  | "edit"
  | "extend";

export type OmniInputPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mime_type: string }
  | { type: "image"; uri: string; mime_type?: string }
  | { type: "video"; uri: string; mime_type?: string };

export type OmniDelivery = "uri" | "inline";

export interface OmniVideoFormat {
  aspectRatio?: string;
  resolution?: string;
  /** Whole seconds, 3–10. */
  durationSeconds?: number;
}

export interface OmniRequestOptions extends OmniVideoFormat {
  model: string;
  prompt: string;
  /** Image and video parts, sent before the prompt in the order given. */
  media?: OmniInputPart[];
  previousInteractionId?: string;
  task?: OmniVideoTask;
  delivery?: OmniDelivery;
  /**
   * true (default): stored server-side and run in the background, so the id
   * comes back at once and the result can be polled, resumed and edited.
   * false: one synchronous request that is not stored (nothing to resume or edit).
   */
  store?: boolean;
}

export interface OmniVideoPart {
  mimeType: string;
  /** Base64 bytes, when delivered inline. */
  data?: string;
  /** Files API URI, when delivered by URI. */
  uri?: string;
}

export interface OmniUsage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
  total_tokens?: number;
  output_tokens_by_modality?: Array<{ modality?: string; tokens?: number }>;
  [key: string]: unknown;
}

export interface Interaction {
  id?: string;
  status?: string;
  model?: string;
  created?: string;
  updated?: string;
  previous_interaction_id?: string;
  steps?: Array<{ type?: string; content?: unknown }>;
  usage?: OmniUsage;
  error?: { message?: string; code?: string | number };
}

/** Statuses after which the interaction never changes again. */
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "incomplete"]);

export function isTerminalInteraction(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_STATUSES.has(status);
}

/** Reject options the Omni API does not accept, before anything is billed. */
export function validateOmniFormat(format: OmniVideoFormat): void {
  const { aspectRatio, resolution, durationSeconds } = format;
  if (
    aspectRatio !== undefined &&
    !(OMNI_ASPECT_RATIOS as readonly string[]).includes(aspectRatio)
  ) {
    throw new ValidationError(
      `Gemini Omni supports --aspect-ratio ${OMNI_ASPECT_RATIOS.join(" or ")} (got '${aspectRatio}')`,
    );
  }
  if (resolution !== undefined && !(OMNI_RESOLUTIONS as readonly string[]).includes(resolution)) {
    throw new ValidationError(
      `Gemini Omni supports --resolution ${OMNI_RESOLUTIONS.join(", ")} (got '${resolution}')`,
    );
  }
  if (
    durationSeconds !== undefined &&
    (!Number.isInteger(durationSeconds) ||
      durationSeconds < OMNI_MIN_DURATION_SECONDS ||
      durationSeconds > OMNI_MAX_DURATION_SECONDS)
  ) {
    throw new ValidationError(
      `Gemini Omni supports --duration ${OMNI_MIN_DURATION_SECONDS}-${OMNI_MAX_DURATION_SECONDS} whole seconds (got '${durationSeconds}')`,
    );
  }
}

/** Parse a CLI `--duration` value (whole seconds) for Omni. */
export function parseOmniDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().replace(/s$/i, "");
  const seconds = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  validateOmniFormat({ durationSeconds: seconds });
  return seconds;
}

/**
 * A follow-up turn cannot carry `task` (the API rejects it beside
 * previous_interaction_id), so the intent goes into the prompt, phrased as in
 * the Omni docs. Checked live: without it, extend-video "the ball turns blue"
 * came back as a same-length edit, and "the ball falls off the edge of the
 * table" (what edit-video sent) as a 10 s extension.
 */
const FOLLOW_UP_PREFIXES: Partial<Record<OmniVideoTask, string>> = {
  edit: "Edit this video: ",
  extend: "Extend this video: ",
};

/** The prompt sent for a follow-up turn: the task's prefix, unless the prompt already names an intent. */
export function followUpPrompt(prompt: string, task: OmniVideoTask | undefined): string {
  const prefix = task ? FOLLOW_UP_PREFIXES[task] : undefined;
  const text = prompt.trimStart();
  if (!prefix || /^(edit|extend) this video\b/i.test(text)) return prompt;
  return `${prefix}${text}`;
}

/** Build the POST /v1beta/interactions body for an Omni video request. */
export function buildOmniRequest(opts: OmniRequestOptions): Record<string, unknown> {
  validateOmniFormat(opts);
  const store = opts.store ?? true;
  const responseFormat: Record<string, unknown> = {
    type: "video",
    // URI delivery points at a stored file, so an unstored request gets the bytes inline.
    delivery: opts.delivery ?? (store ? "uri" : "inline"),
  };
  if (opts.aspectRatio) responseFormat.aspect_ratio = opts.aspectRatio;
  if (opts.resolution) responseFormat.resolution = opts.resolution;
  if (opts.durationSeconds !== undefined) responseFormat.duration = `${opts.durationSeconds}s`;

  const media = opts.media ?? [];
  const prompt = opts.previousInteractionId ? followUpPrompt(opts.prompt, opts.task) : opts.prompt;
  const body: Record<string, unknown> = {
    model: opts.model.replace(/^models\//, ""),
    input: media.length > 0 ? [...media, { type: "text", text: prompt }] : prompt,
    response_format: responseFormat,
    store,
    // A background interaction must be stored; an unstored one runs synchronously.
    background: store,
  };
  if (opts.previousInteractionId) body.previous_interaction_id = opts.previousInteractionId;
  // The API rejects a task next to previous_interaction_id: a follow-up turn
  // takes its edit/extend intent from the prompt prefix above.
  if (opts.task && !opts.previousInteractionId) {
    body.generation_config = { video_config: { task: opts.task } };
  }
  return body;
}

/**
 * The generated video in a raw REST Interaction: the last `type: "video"`
 * part of a `model_output` step. Input steps (`user_input`) are skipped, so an
 * uploaded source video is never mistaken for the result.
 */
export function extractOmniVideo(resp: unknown): OmniVideoPart | null {
  const steps = (resp as Interaction | null)?.steps;
  if (!Array.isArray(steps)) return null;
  let found: OmniVideoPart | null = null;
  for (const step of steps) {
    if (step?.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const part of step.content as Array<Record<string, unknown>>) {
      if (part?.type !== "video") continue;
      const mimeType = typeof part.mime_type === "string" ? part.mime_type : "video/mp4";
      if (typeof part.uri === "string" && part.uri) found = { mimeType, uri: part.uri };
      else if (typeof part.data === "string" && part.data) found = { mimeType, data: part.data };
    }
  }
  return found;
}

/** Text the model returned instead of (or alongside) a video, e.g. a refusal. */
export function extractOmniText(resp: unknown): string {
  const steps = (resp as Interaction | null)?.steps ?? [];
  const texts: string[] = [];
  for (const step of steps) {
    if (step?.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const part of step.content as Array<Record<string, unknown>>) {
      if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  return texts.join("\n").trim();
}

/** Bytes a base64 string decodes to, without decoding it. */
export function base64DecodedBytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

export interface OmniCostEstimate {
  usd: number;
  basis: string;
}

/** List-price estimate from the reported usage; null when usage is missing. */
export function estimateOmniCost(usage: OmniUsage | undefined): OmniCostEstimate | null {
  if (!usage) return null;
  const input = usage.total_input_tokens ?? 0;
  const thought = usage.total_thought_tokens ?? 0;
  const byModality = usage.output_tokens_by_modality ?? [];
  const video = byModality
    .filter((m) => m?.modality === "video")
    .reduce((n, m) => n + (m.tokens ?? 0), 0);
  const otherOutput = Math.max(0, (usage.total_output_tokens ?? 0) - video);
  if (input + thought + video + otherOutput === 0) return null;
  const p = OMNI_PRICE_PER_M_TOKENS;
  const usd =
    (input * p.input + (otherOutput + thought) * p.textOutput + video * p.videoOutput) / 1_000_000;
  return {
    usd: Math.round(usd * 10_000) / 10_000,
    basis: "estimate from reported token usage at paid-tier list prices; not the billed amount",
  };
}

/**
 * Small, log-safe view of an interaction: no media bytes, thought signatures
 * or file URIs (the Files API name stands in for the URI).
 */
export function summarizeInteraction(resp: unknown): Record<string, unknown> {
  const it = (resp ?? {}) as Interaction;
  const video = extractOmniVideo(resp);
  const summary: Record<string, unknown> = {
    interaction_id: it.id,
    status: it.status,
    model: it.model,
  };
  if (it.previous_interaction_id) summary.parent_interaction_id = it.previous_interaction_id;
  if (it.created) summary.created_at = it.created;
  if (it.updated) summary.updated_at = it.updated;
  if (video) {
    summary.video = {
      mime_type: video.mimeType,
      delivery: video.uri ? "uri" : "inline",
      ...(video.uri ? { media_file: mediaFileName(video.uri) } : {}),
      ...(video.data ? { bytes: base64DecodedBytes(video.data) } : {}),
    };
  }
  const text = extractOmniText(resp);
  if (text) summary.text = text.slice(0, 2000);
  if (it.usage) summary.usage = it.usage;
  const cost = estimateOmniCost(it.usage);
  if (cost) summary.cost_estimate = cost;
  if (it.error) summary.error = it.error;
  return summary;
}

/** `files/<id>` from a Files API URI, or "(external)" for anything else. */
function mediaFileName(uri: string): string {
  const match = /\/v1beta\/(files\/[A-Za-z0-9_-]+)/.exec(uri);
  return match?.[1] ?? "(external)";
}

/** One-line reason for a non-completed terminal interaction. */
export function interactionFailureMessage(resp: unknown): string {
  const it = (resp ?? {}) as Interaction;
  const detail = typeof it.error?.message === "string" ? `: ${it.error.message}` : "";
  const text = extractOmniText(resp);
  return `Gemini Omni interaction ${it.id ?? ""} ${it.status ?? "unknown"}${detail}${
    !detail && text ? `: ${text.slice(0, 300)}` : ""
  }`.replace(/\s+/g, " ");
}
