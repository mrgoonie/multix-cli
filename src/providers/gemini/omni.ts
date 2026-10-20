/**
 * Gemini Omni Flash video over the Interactions API.
 * Contract (https://ai.google.dev/gemini-api/docs/omni):
 *   POST /v1beta/interactions
 *     { model, input: "prompt" | [parts], previous_interaction_id?,
 *       response_format: { type: "video", aspect_ratio?, resolution?, delivery? },
 *       generation_config?: { video_config: { task } }, store?, background? }
 *   Parts: { type: "text", text } | { type: "image", data, mime_type }
 *          | { type: "image" | "video", uri, mime_type? } (Files API URIs).
 *   The raw REST video is a `{ type: "video", mime_type, data | uri }` item in
 *   `steps[].content[]`; `output_video` exists in the SDKs only.
 *   A `uri` points at a Files API file: wait until it is ACTIVE (or FAILED),
 *   then download `files/{id}:download?alt=media` with the same key.
 *   GET /v1beta/interactions/{id} returns the stored interaction, with the
 *   video inline even when it was created with `delivery: "uri"`.
 *
 * Runtime-neutral: no node:* imports, no env or disk access. Callers pass the
 * API key (and optionally `fetch`); the CLI keeps one key for a whole flow.
 */

import { pollUntil } from "../../core/async-poll.js";
import { ProviderError, ValidationError } from "../../core/errors.js";
import { type FetchLike, fetchJson } from "../../core/fetch-json.js";
import { createInteraction, getInteraction } from "./client.js";

export const OMNI_API_HOST = "generativelanguage.googleapis.com";
const API_HOST = OMNI_API_HOST;
const BASE = `https://${API_HOST}/v1beta`;

export const OMNI_ASPECT_RATIOS = ["16:9", "9:16"] as const;
export const OMNI_RESOLUTIONS = ["360p", "720p", "1080p", "4k"] as const;
export const OMNI_TASKS = [
  "text_to_video",
  "image_to_video",
  "reference_to_video",
  "edit",
  "extend",
] as const;
export const OMNI_DELIVERIES = ["uri", "inline"] as const;
export type OmniDelivery = (typeof OMNI_DELIVERIES)[number];

/** Interaction states that may still change; anything else is final. */
const RUNNING_STATES = new Set(["in_progress", "queued", "pending"]);

export type OmniMedia = { data: string; mimeType: string } | { uri: string; mimeType?: string };

export interface OmniRequestOptions {
  model: string;
  prompt: string;
  /** Image parts, in order (first/last frame, subject or extension references). */
  images?: OmniMedia[];
  /** One video part (an uploaded Files API video to edit or extend). */
  video?: { uri: string; mimeType?: string };
  previousInteractionId?: string;
  aspectRatio?: string;
  resolution?: string;
  delivery?: OmniDelivery;
  task?: string;
  /** false sends `store: false`; the result then cannot be edited or retrieved later. */
  store?: boolean;
  background?: boolean;
}

function oneOf(name: string, value: string | undefined, allowed: readonly string[]): void {
  if (value !== undefined && !allowed.includes(value)) {
    throw new ValidationError(`${name} must be one of ${allowed.join(", ")} (got '${value}')`);
  }
}

/** Check the Omni-specific options without building a request. */
export function validateOmniOptions(
  opts: Pick<
    OmniRequestOptions,
    "aspectRatio" | "resolution" | "delivery" | "task" | "store" | "background"
  >,
): void {
  oneOf("--aspect-ratio", opts.aspectRatio, OMNI_ASPECT_RATIOS);
  oneOf("--resolution", opts.resolution, OMNI_RESOLUTIONS);
  oneOf("--delivery", opts.delivery, OMNI_DELIVERIES);
  oneOf("--task", opts.task, OMNI_TASKS);
  if (opts.store === false && opts.background) {
    throw new ValidationError("--background needs a stored interaction; drop --no-store");
  }
}

function mediaPart(type: "image" | "video", media: OmniMedia): Record<string, unknown> {
  if ("data" in media) return { type, data: media.data, mime_type: media.mimeType };
  return media.mimeType
    ? { type, uri: media.uri, mime_type: media.mimeType }
    : { type, uri: media.uri };
}

export function buildOmniRequest(opts: OmniRequestOptions): Record<string, unknown> {
  validateOmniOptions(opts);
  const prompt = opts.prompt.trim();
  if (!prompt) throw new ValidationError("--prompt must not be empty");
  const parts = [
    ...(opts.video ? [mediaPart("video", opts.video)] : []),
    ...(opts.images ?? []).map((img) => mediaPart("image", img)),
  ];
  const responseFormat: Record<string, unknown> = { type: "video" };
  if (opts.aspectRatio) responseFormat.aspect_ratio = opts.aspectRatio;
  if (opts.resolution) responseFormat.resolution = opts.resolution;
  if (opts.delivery === "uri") responseFormat.delivery = "uri";

  const body: Record<string, unknown> = {
    model: opts.model.replace(/^models\//, ""),
    input: parts.length > 0 ? [...parts, { type: "text", text: prompt }] : prompt,
    response_format: responseFormat,
  };
  if (opts.previousInteractionId) body.previous_interaction_id = opts.previousInteractionId;
  if (opts.task) body.generation_config = { video_config: { task: opts.task } };
  if (opts.store === false) body.store = false;
  if (opts.background) body.background = true;
  return body;
}

/** The parts of an Interaction resource this module reads. */
export interface OmniInteraction {
  id?: string;
  status?: string;
  model?: string;
  steps?: unknown[];
  usage?: unknown;
  error?: unknown;
}

export interface OmniVideo {
  mimeType: string;
  /** Base64 MP4 (inline delivery, and every GET of a stored interaction). */
  data?: string;
  /** Files API URI (delivery "uri", creation response only). */
  uri?: string;
}

function asInteraction(resp: unknown, what: string): OmniInteraction {
  if (!resp || typeof resp !== "object" || Array.isArray(resp)) {
    throw new ProviderError(`Gemini Omni ${what} returned no interaction`, "gemini");
  }
  return resp as OmniInteraction;
}

/**
 * The generated video from the raw REST steps: the last `video` item in
 * `steps[].content[]`, skipping `user_input` steps (a stored interaction
 * echoes the caller's own input video there). `output_video` is ignored: it
 * is an SDK-only convenience field, never part of the REST response.
 */
export function extractOmniVideo(resp: unknown): OmniVideo | undefined {
  const steps = (resp as OmniInteraction | undefined)?.steps;
  if (!Array.isArray(steps)) return undefined;
  let found: OmniVideo | undefined;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const s = step as { type?: unknown; content?: unknown };
    if (s.type === "user_input" || !Array.isArray(s.content)) continue;
    for (const item of s.content) {
      if (!item || typeof item !== "object") continue;
      const c = item as Record<string, unknown>;
      if (c.type !== "video") continue;
      const mimeType = typeof c.mime_type === "string" ? c.mime_type : "video/mp4";
      if (typeof c.data === "string" && c.data.length > 0) found = { mimeType, data: c.data };
      else if (typeof c.uri === "string" && c.uri.length > 0) found = { mimeType, uri: c.uri };
    }
  }
  return found;
}

export function isOmniRunning(resp: OmniInteraction): boolean {
  return typeof resp.status === "string" && RUNNING_STATES.has(resp.status);
}

/** Throw for a final interaction that did not complete (failed, cancelled, requires_action). */
export function assertOmniCompleted(resp: OmniInteraction): void {
  const status = resp.status;
  if (status === undefined || status === "completed") return;
  const detail = resp.error === undefined ? "" : `: ${JSON.stringify(resp.error).slice(0, 500)}`;
  throw new ProviderError(
    `Gemini Omni interaction ${resp.id ?? "(no id)"} ended with status '${status}'${detail}`,
    "gemini",
  );
}

export interface OmniCallOptions {
  apiKey: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

export async function createOmniInteraction(
  body: Record<string, unknown>,
  opts: OmniCallOptions,
): Promise<OmniInteraction> {
  return asInteraction(await createInteraction(body, opts), "request");
}

export async function getOmniInteraction(
  id: string,
  opts: OmniCallOptions,
): Promise<OmniInteraction> {
  return asInteraction(await getInteraction(id, opts), "lookup");
}

export interface OmniPollOptions extends OmniCallOptions {
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onPoll?: (status: string | undefined, attempt: number) => void;
  resumeHint?: string;
}

/** Poll a stored interaction until it leaves in_progress (bounded by `timeoutMs`). */
export async function waitForOmniInteraction(
  id: string,
  opts: OmniPollOptions,
): Promise<OmniInteraction> {
  return pollUntil<OmniInteraction>({
    fetchStatus: ({ remainingMs }) =>
      getOmniInteraction(id, { ...opts, timeoutMs: Math.min(remainingMs, 120_000) }),
    isTerminal: (resp) => !isOmniRunning(resp),
    timeoutMs: opts.timeoutMs ?? 15 * 60_000,
    intervalMs: opts.intervalMs ?? 10_000,
    maxIntervalMs: 30_000,
    sleep: opts.sleep,
    onPoll: (resp, attempt) => opts.onPoll?.(resp.status, attempt),
    resumeHint: opts.resumeHint,
  });
}

/**
 * The Files API resource name ("files/abc") for a video URI on the Gemini API
 * host, or undefined for any other URL. Only these URIs get the API key.
 */
export function geminiFileName(uri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== API_HOST || url.port !== "") return undefined;
  const m = /^\/v1beta\/(files\/[A-Za-z0-9_-]+)(?::download)?$/.exec(url.pathname);
  return m?.[1];
}

/** Canonical download URL for a Files API resource name. */
export function geminiFileDownloadUrl(name: string): string {
  return `${BASE}/${name}:download?alt=media`;
}

interface FileStatus {
  state?: string;
  error?: unknown;
}

/** Wait until a generated file is ACTIVE; FAILED or the deadline throws. */
export async function waitForGeminiFileActive(name: string, opts: OmniPollOptions): Promise<void> {
  const final = await pollUntil<FileStatus>({
    fetchStatus: async ({ remainingMs }) => {
      const resp = await fetchJson<FileStatus & { file?: FileStatus }>({
        url: `${BASE}/${name}`,
        headers: { "x-goog-api-key": opts.apiKey },
        timeoutMs: Math.min(remainingMs, 60_000),
        fetch: opts.fetch,
      });
      return resp?.file ?? resp ?? {};
    },
    // A file without a state is treated as ready; the download reports any problem.
    isTerminal: (f) => f.state !== "PROCESSING" && f.state !== "STATE_UNSPECIFIED",
    timeoutMs: opts.timeoutMs ?? 10 * 60_000,
    intervalMs: opts.intervalMs ?? 5_000,
    maxIntervalMs: 15_000,
    sleep: opts.sleep,
    onPoll: (f, attempt) => opts.onPoll?.(f.state, attempt),
    resumeHint: opts.resumeHint,
  });
  if (final.state === "FAILED") {
    const detail =
      final.error === undefined ? "" : `: ${JSON.stringify(final.error).slice(0, 300)}`;
    throw new ProviderError(`Gemini file ${name} failed processing${detail}`, "gemini");
  }
}
