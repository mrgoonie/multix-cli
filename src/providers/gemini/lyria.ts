/**
 * Lyria music generation over the Gemini Interactions API
 * (POST /v1beta/interactions), runtime-neutral: no node:* imports, no env or
 * disk access, so a Worker can reuse the request and response handling.
 *
 * - `lyria-3-clip-preview`: 30-second clip, MP3.
 * - `lyria-3.5`: full song (about a couple of minutes, steered by the prompt),
 *   MP3 by default or WAV through `response_format`.
 *
 * Both take a text prompt plus up to 10 images. Lyrics and section timing are
 * plain prompt text (`[Verse]`, `[0:00 - 0:10] Intro: …`). The response carries
 * the song as a base64 audio block in a `model_output` step, and the lyrics or
 * song structure as text blocks next to it.
 *
 * Reference: https://ai.google.dev/gemini-api/docs/music-generation
 */

import { ProviderError, ValidationError } from "../../core/errors.js";

export const LYRIA_CLIP_MODEL = "lyria-3-clip-preview";
export const LYRIA_SONG_MODEL = "lyria-3.5";

/** The cheapest model: one 30-second clip. */
export const MUSIC_MODEL_DEFAULT = LYRIA_CLIP_MODEL;

export const MUSIC_OUTPUT_FORMATS = ["mp3", "wav"] as const;
export type MusicOutputFormat = (typeof MUSIC_OUTPUT_FORMATS)[number];

export interface LyriaModelSpec {
  formats: readonly MusicOutputFormat[];
  /** Length of the song, in words; the clip model always returns 30 s. */
  duration: string;
}

export const LYRIA_MODELS: Readonly<Record<string, LyriaModelSpec>> = {
  [LYRIA_CLIP_MODEL]: { formats: ["mp3"], duration: "30 seconds" },
  [LYRIA_SONG_MODEL]: { formats: ["mp3", "wav"], duration: "about a couple of minutes" },
};

export function isLyriaModel(model: string): boolean {
  return Object.hasOwn(LYRIA_MODELS, model);
}

/** Images the Interactions API takes alongside a Lyria prompt. */
export const LYRIA_MAX_IMAGES = 10;

export interface LyriaImage {
  mimeType: string;
  /** Base64 image bytes. */
  data: string;
}

export interface LyriaRequest {
  model: string;
  prompt: string;
  /** Lyrics with optional section tags; sent as part of the prompt text. */
  lyrics?: string;
  images?: LyriaImage[];
  outputFormat?: MusicOutputFormat;
}

/** Reject a model, format or input the selected Lyria model does not take, before any request. */
export function validateLyriaRequest(req: LyriaRequest): void {
  const spec = LYRIA_MODELS[req.model];
  if (!spec) {
    throw new ValidationError(
      `--model must be one of: ${Object.keys(LYRIA_MODELS).join(", ")} (got "${req.model}")`,
    );
  }
  if (!req.prompt.trim()) throw new ValidationError("--prompt must not be empty");
  if (req.lyrics !== undefined && !req.lyrics.trim()) {
    throw new ValidationError("--lyrics must not be empty");
  }
  const format = req.outputFormat ?? "mp3";
  if (!spec.formats.includes(format)) {
    throw new ValidationError(
      `${req.model} returns ${spec.formats.join("|")} only; --output-format ${format} needs ${LYRIA_SONG_MODEL}`,
    );
  }
  const images = req.images ?? [];
  if (images.length > LYRIA_MAX_IMAGES) {
    throw new ValidationError(
      `Lyria takes at most ${LYRIA_MAX_IMAGES} images (got ${images.length})`,
    );
  }
  for (const img of images) {
    if (!/^image\/(png|jpeg|webp|heic|heif)$/.test(img.mimeType)) {
      throw new ValidationError(`Unsupported image type for Lyria: ${img.mimeType}`);
    }
  }
}

/** The prompt text Lyria receives: the description, then the lyrics when given. */
export function lyriaPromptText(req: Pick<LyriaRequest, "prompt" | "lyrics">): string {
  const prompt = req.prompt.trim();
  if (req.lyrics === undefined) return prompt;
  return `${prompt}\n\nUse the following lyrics:\n${req.lyrics.trim()}`;
}

/** Build the POST /v1beta/interactions body for a Lyria request. */
export function buildLyriaInteractionBody(req: LyriaRequest): Record<string, unknown> {
  validateLyriaRequest(req);
  const text = lyriaPromptText(req);
  const images = req.images ?? [];
  const body: Record<string, unknown> = {
    model: req.model,
    input:
      images.length === 0
        ? text
        : [
            { type: "text", text },
            ...images.map((img) => ({ type: "image", mime_type: img.mimeType, data: img.data })),
          ],
  };
  // MP3 is the default; only WAV is asked for explicitly.
  if (req.outputFormat === "wav") body.response_format = { type: "audio", mime_type: "audio/wav" };
  return body;
}

export interface LyriaResult {
  /** Interaction id (stored interactions only). */
  id?: string;
  audio: { mimeType: string; data: string };
  /** Lyrics or song structure the model returned, if any. */
  text?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Content blocks the model produced: `model_output` steps, or the older top-level `outputs`. */
function outputBlocks(resp: Record<string, unknown>): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  if (Array.isArray(resp.steps)) {
    for (const step of resp.steps) {
      const s = asRecord(step);
      if (s?.type !== "model_output" || !Array.isArray(s.content)) continue;
      for (const c of s.content) {
        const block = asRecord(c);
        if (block) blocks.push(block);
      }
    }
  } else if (Array.isArray(resp.outputs)) {
    for (const o of resp.outputs) {
      const block = asRecord(o);
      if (block) blocks.push(block);
    }
  }
  return blocks;
}

/**
 * Read a Lyria Interaction: the last audio block (as the SDK's `output_audio`)
 * and the text blocks. A non-completed status, or a response without audio,
 * is a ProviderError that carries the model's text (often the safety reason).
 */
export function parseLyriaInteraction(resp: unknown): LyriaResult {
  const r = asRecord(resp);
  if (!r) throw new ProviderError("Malformed Lyria response (not a JSON object)", "gemini");
  const id = typeof r.id === "string" ? r.id : undefined;
  const blocks = outputBlocks(r);
  const text = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
  if (typeof r.status === "string" && r.status !== "completed") {
    const err = asRecord(r.error);
    const detail = typeof err?.message === "string" ? `: ${err.message}` : text ? `: ${text}` : "";
    throw new ProviderError(`Lyria interaction ${r.status}${detail}`, "gemini");
  }
  let audio: LyriaResult["audio"] | undefined;
  for (const b of blocks) {
    if (b.type !== "audio" || typeof b.data !== "string" || b.data.length === 0) continue;
    const mime = typeof b.mime_type === "string" ? b.mime_type : b.mimeType;
    audio = { mimeType: typeof mime === "string" ? mime : "audio/mpeg", data: b.data };
  }
  if (!audio) {
    throw new ProviderError(
      `Lyria returned no audio${text ? `: ${text.slice(0, 500)}` : " (empty response)"}`,
      "gemini",
    );
  }
  return { ...(id ? { id } : {}), audio, ...(text ? { text } : {}) };
}
