/**
 * Gemini Lyria music generation over the Interactions API.
 * Contract (https://ai.google.dev/gemini-api/docs/music-generation, checked
 * against the live API on 2026-10-31):
 *   POST /v1beta/interactions
 *     { model, input: string | [text and image parts], store, background,
 *       response_format?: { type: "audio", mime_type: "audio/wav" } }
 *   GET  /v1beta/interactions/{id} until `status` leaves in_progress
 *   The song is a `{ type: "audio", data }` part (base64, no mime_type) in the
 *   `model_output` step of `steps[]`; lyrics and structure, when the model
 *   returns them, are `{ type: "text" }` parts of that step. `output_audio`
 *   and `output_text` are SDK conveniences, never part of the REST resource.
 *
 * Live checks behind the rules below: `background: true` works for both
 * models; `response_format: { type: "audio" }` alone (the docs' example) still
 * returns MP3, and WAV needs `mime_type: "audio/wav"`.
 *
 * Runtime-neutral: no node:* imports, env or disk access. The CLI flow (key
 * choice, polling, files on disk) is lyria-flow.ts.
 */

import { ValidationError } from "../../core/errors.js";
import { type Interaction, base64DecodedBytes, extractOmniText } from "./omni.js";

/** 30-second clips, MP3 only. */
export const LYRIA_CLIP_MODEL = "lyria-3-clip-preview";
/** Full songs (about a couple of minutes, steered by the prompt), MP3 or WAV. */
export const LYRIA_SONG_MODEL = "lyria-3.5";
export const LYRIA_MODEL_DEFAULT = LYRIA_CLIP_MODEL;

export type LyriaFormat = "mp3" | "wav";
export const LYRIA_FORMATS: readonly LyriaFormat[] = ["mp3", "wav"];

export interface LyriaModelSpec {
  id: string;
  name: string;
  formats: readonly LyriaFormat[];
  /** Reference images sent with the prompt (0: the model takes none). */
  maxImages: number;
  /** Fixed clip length; undefined when the prompt steers it. */
  fixedSeconds?: number;
  /** USD per successful request on the paid tier (ai.google.dev/gemini-api/docs/pricing). */
  usdPerRequest: number;
}

export const LYRIA_MODELS: Readonly<Record<string, LyriaModelSpec>> = {
  [LYRIA_CLIP_MODEL]: {
    id: LYRIA_CLIP_MODEL,
    name: "Lyria 3 Clip",
    formats: ["mp3"],
    maxImages: 0,
    fixedSeconds: 30,
    usdPerRequest: 0.04,
  },
  [LYRIA_SONG_MODEL]: {
    id: LYRIA_SONG_MODEL,
    name: "Lyria 3.5",
    formats: ["mp3", "wav"],
    maxImages: 10,
    usdPerRequest: 0.08,
  },
};

/** Image types sent inline as reference images. */
export const LYRIA_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export type LyriaInputPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mime_type: string };

export interface LyriaRequestOptions {
  model: string;
  prompt: string;
  /** Lyrics with optional [Verse]/[Chorus] section tags, sent after the prompt. */
  lyrics?: string;
  images?: Array<{ data: string; mime_type: string }>;
  format?: LyriaFormat;
}

/** The spec of a supported Lyria model; anything else is rejected before a request. */
export function lyriaModelSpec(model: string): LyriaModelSpec {
  const id = model.trim().replace(/^models\//, "");
  const spec = LYRIA_MODELS[id];
  if (!spec) {
    throw new ValidationError(
      `Unsupported Lyria model '${model}'. Use ${Object.keys(LYRIA_MODELS).join(" or ")} (lyria-realtime-exp streams over a different API).`,
    );
  }
  return spec;
}

/** Reject options the selected model does not take, before anything is billed. */
export function validateLyriaRequest(opts: {
  model: string;
  prompt?: string;
  format?: string;
  imageCount?: number;
}): LyriaModelSpec {
  const spec = lyriaModelSpec(opts.model);
  if (opts.prompt !== undefined && !opts.prompt.trim()) {
    throw new ValidationError("--prompt must not be empty");
  }
  if (opts.format !== undefined && !(spec.formats as readonly string[]).includes(opts.format)) {
    throw new ValidationError(
      `${spec.id} supports --output-format ${spec.formats.join(" or ")} (got '${opts.format}')`,
    );
  }
  const images = opts.imageCount ?? 0;
  if (images > spec.maxImages) {
    throw new ValidationError(
      spec.maxImages === 0
        ? `${spec.id} does not take reference images; use ${LYRIA_SONG_MODEL}`
        : `${spec.id} takes at most ${spec.maxImages} reference images (got ${images})`,
    );
  }
  return spec;
}

/** The text sent to the model: the prompt, then the lyrics under a heading. */
export function lyriaPromptText(prompt: string, lyrics?: string): string {
  const words = lyrics?.trim();
  return words ? `${prompt.trim()}\n\nLyrics:\n${words}` : prompt.trim();
}

/** Build the POST /v1beta/interactions body: always stored and run in the background, so it can be resumed. */
export function buildLyriaRequest(opts: LyriaRequestOptions): Record<string, unknown> {
  const spec = validateLyriaRequest({
    model: opts.model,
    prompt: opts.prompt,
    format: opts.format,
    imageCount: opts.images?.length,
  });
  const text = lyriaPromptText(opts.prompt, opts.lyrics);
  const images = opts.images ?? [];
  const body: Record<string, unknown> = {
    model: spec.id,
    input:
      images.length > 0
        ? [{ type: "text", text }, ...images.map((img) => ({ type: "image", ...img }))]
        : text,
    store: true,
    background: true,
  };
  if (opts.format === "wav") body.response_format = { type: "audio", mime_type: "audio/wav" };
  return body;
}

export interface LyriaAudioPart {
  /** Base64 audio bytes. */
  data: string;
  mimeType?: string;
}

/** The last `type: "audio"` part of a `model_output` step (input steps are skipped). */
export function extractLyriaAudio(resp: unknown): LyriaAudioPart | null {
  const steps = (resp as Interaction | null)?.steps;
  if (!Array.isArray(steps)) return null;
  let found: LyriaAudioPart | null = null;
  for (const step of steps) {
    if (step?.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const part of step.content as Array<Record<string, unknown>>) {
      if (part?.type !== "audio" || typeof part.data !== "string" || !part.data) continue;
      found = {
        data: part.data,
        ...(typeof part.mime_type === "string" ? { mimeType: part.mime_type } : {}),
      };
    }
  }
  return found;
}

/** Lyrics and structure the model returned as text (empty when it returned none). */
export function extractLyriaText(resp: unknown): string {
  return extractOmniText(resp);
}

/**
 * The file type of decoded audio, from its first bytes: a RIFF/WAVE header
 * or an MP3 (ID3 tag or MPEG frame sync). null for anything else.
 */
export function sniffAudioFormat(bytes: Uint8Array): LyriaFormat | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (bytes.length >= 3 && ascii(0, 3) === "ID3") return "mp3";
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return "mp3";
  return null;
}

export interface LyriaCost {
  usd: number;
  basis: string;
}

/** List price of one completed request; null for a model without a known price. */
export function lyriaCost(model: string | undefined): LyriaCost | null {
  const spec = model ? LYRIA_MODELS[model.replace(/^models\//, "")] : undefined;
  if (!spec) return null;
  return {
    usd: spec.usdPerRequest,
    basis:
      "paid-tier list price per song (ai.google.dev/gemini-api/docs/pricing); not the billed amount",
  };
}

/** Small, log-safe view of a music interaction: no audio bytes. */
export function summarizeLyriaInteraction(resp: unknown): Record<string, unknown> {
  const it = (resp ?? {}) as Interaction;
  const summary: Record<string, unknown> = {
    interaction_id: it.id,
    status: it.status,
    model: it.model,
  };
  if (it.created) summary.created_at = it.created;
  if (it.updated) summary.updated_at = it.updated;
  const audio = extractLyriaAudio(resp);
  if (audio) {
    summary.audio = {
      bytes: base64DecodedBytes(audio.data),
      ...(audio.mimeType ? { mime_type: audio.mimeType } : {}),
    };
  }
  const text = extractLyriaText(resp);
  if (text) summary.text = text.slice(0, 4000);
  if (it.usage) summary.usage = it.usage;
  if (it.status === "completed") {
    const cost = lyriaCost(it.model);
    if (cost) summary.cost_estimate = cost;
  }
  if (it.error) summary.error = it.error;
  return summary;
}

/** One-line reason for a non-completed terminal interaction. */
export function lyriaFailureMessage(resp: unknown): string {
  const it = (resp ?? {}) as Interaction;
  const detail = typeof it.error?.message === "string" ? `: ${it.error.message}` : "";
  const text = extractLyriaText(resp);
  return `Gemini Lyria interaction ${it.id ?? ""} ${it.status ?? "unknown"}${detail}${
    !detail && text ? `: ${text.slice(0, 300)}` : ""
  }`.replace(/\s+/g, " ");
}
