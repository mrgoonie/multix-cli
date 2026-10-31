/**
 * Lyria music generation over the Gemini Interactions API
 * (https://ai.google.dev/gemini-api/docs/music-generation).
 *
 *   POST /v1beta/interactions
 *     { model, input: string | [{type:"text"}, {type:"image", mime_type, data}],
 *       response_format?: { type: "audio", mime_type: "audio/wav" } }
 *
 * The request is synchronous: the response is the finished Interaction, whose
 * `model_output` steps hold base64 audio blocks and text blocks (lyrics or a
 * JSON description of the song structure). Lyrics and timing are plain text in
 * the prompt (`[Verse]`, `[0:00 - 0:10] Intro:`).
 *
 * Runtime-neutral: no node:* imports; reading images and saving audio stay in
 * the command layer.
 */

import { ProviderError, ValidationError } from "../../core/errors.js";
import { type LyriaMusicModel, findLyriaMusicModel } from "./models.js";

export type MusicOutputFormat = "mp3" | "wav";

export const MUSIC_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface MusicImage {
  mimeType: string;
  /** Base64 image bytes. */
  data: string;
}

export interface MusicRequest {
  model: string;
  prompt: string;
  lyrics?: string;
  images?: MusicImage[];
  outputFormat?: MusicOutputFormat;
}

/** The model's capabilities, or a ValidationError naming the supported ids. */
export function requireLyriaModel(model: string): LyriaMusicModel {
  const found = findLyriaMusicModel(model);
  if (!found) {
    throw new ValidationError(
      `Unsupported music model "${model}". Use one of: lyria-3-clip-preview, lyria-3.5`,
    );
  }
  return found;
}

/** Validate a request against the model's capabilities; never drops an option silently. */
export function validateMusicRequest(req: MusicRequest): LyriaMusicModel {
  const model = requireLyriaModel(req.model);
  if (!req.prompt.trim()) throw new ValidationError("--prompt must not be empty");
  if (req.lyrics !== undefined && !req.lyrics.trim()) {
    throw new ValidationError("Lyrics must not be empty");
  }
  const format = req.outputFormat ?? model.outputFormats[0];
  if (format && !model.outputFormats.includes(format)) {
    throw new ValidationError(
      `${model.id} returns ${model.outputFormats.join(" or ")} only; --output-format ${format} needs lyria-3.5`,
    );
  }
  const images = req.images ?? [];
  if (images.length > model.maxImages) {
    throw new ValidationError(`${model.id} takes at most ${model.maxImages} images`);
  }
  for (const image of images) {
    if (!MUSIC_IMAGE_MIME_TYPES.has(image.mimeType)) {
      throw new ValidationError(`Lyria accepts JPEG, PNG or WebP images (got ${image.mimeType})`);
    }
  }
  return model;
}

/** The prompt text sent to the model: the description, then the lyrics under a heading. */
export function musicPromptText(prompt: string, lyrics?: string): string {
  return lyrics === undefined ? prompt.trim() : `${prompt.trim()}\n\nLyrics:\n${lyrics.trim()}`;
}

/** Build the POST /v1beta/interactions body for a Lyria request. */
export function buildMusicInteractionBody(req: MusicRequest): Record<string, unknown> {
  const model = validateMusicRequest(req);
  const text = musicPromptText(req.prompt, req.lyrics);
  const images = req.images ?? [];
  const body: Record<string, unknown> = {
    model: model.id,
    input:
      images.length === 0
        ? text
        : [
            { type: "text", text },
            ...images.map((i) => ({ type: "image", mime_type: i.mimeType, data: i.data })),
          ],
  };
  // MP3 is the default container; only WAV has to be asked for.
  if (req.outputFormat === "wav") {
    body.response_format = { type: "audio", mime_type: "audio/wav" };
  }
  return body;
}

export interface MusicInteractionResult {
  /** Interaction id, when the response carried one (stored interactions can be fetched again). */
  id?: string;
  status?: string;
  mimeType: string;
  /** Base64 audio of the last audio block. */
  audio: string;
  /** Text blocks of the model output joined by blank lines: lyrics or song structure. */
  text: string;
}

const TERMINAL_FAILURES = new Set(["failed", "cancelled", "incomplete", "budget_exceeded"]);

/**
 * Read the audio and text out of a Lyria Interaction. Throws a ProviderError
 * for a failed, unfinished or empty interaction instead of saving nothing.
 */
export function parseMusicInteraction(resp: unknown): MusicInteractionResult {
  if (!resp || typeof resp !== "object") {
    throw new ProviderError("Lyria returned an empty response", "gemini");
  }
  const o = resp as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : undefined;
  const status = typeof o.status === "string" ? o.status : undefined;
  const ref = id ? ` (interaction ${id})` : "";
  if (status && status !== "completed") {
    const detail = errorDetail(o);
    if (TERMINAL_FAILURES.has(status)) {
      throw new ProviderError(`Lyria interaction ${status}${ref}${detail}`, "gemini");
    }
    throw new ProviderError(
      `Lyria interaction is ${status}${ref}${detail}; fetch it later with --interaction-id instead of generating again`,
      "gemini",
    );
  }

  let audio: { mimeType: string; data: string } | undefined;
  const texts: string[] = [];
  const steps = Array.isArray(o.steps) ? o.steps : [];
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const s = step as Record<string, unknown>;
    if (s.type !== "model_output" || !Array.isArray(s.content)) continue;
    for (const block of s.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "audio" && typeof b.data === "string" && b.data.length > 0) {
        audio = { mimeType: mimeOf(b), data: b.data };
      } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        texts.push(b.text.trim());
      }
    }
  }
  // Responses shaped like the SDK's convenience fields.
  const outputAudio = o.output_audio as Record<string, unknown> | undefined;
  if (!audio && outputAudio && typeof outputAudio.data === "string" && outputAudio.data) {
    audio = { mimeType: mimeOf(outputAudio), data: outputAudio.data };
  }
  if (texts.length === 0 && typeof o.output_text === "string" && o.output_text.trim()) {
    texts.push(o.output_text.trim());
  }

  if (!audio) {
    const why = texts.length > 0 ? `: ${texts.join(" ").slice(0, 300)}` : "";
    throw new ProviderError(`Lyria returned no audio${ref}${why}`, "gemini");
  }
  return {
    ...(id ? { id } : {}),
    ...(status ? { status } : {}),
    mimeType: audio.mimeType,
    audio: audio.data,
    text: texts.join("\n\n"),
  };
}

function mimeOf(block: Record<string, unknown>): string {
  const mime = block.mime_type ?? block.mimeType;
  return typeof mime === "string" && mime ? mime : "audio/mpeg";
}

function errorDetail(o: Record<string, unknown>): string {
  const error = o.error as { message?: unknown } | undefined;
  if (typeof error?.message === "string") return `: ${error.message}`;
  const errors = Array.isArray(o.errors) ? o.errors : [];
  const first = errors[0] as { message?: unknown } | undefined;
  return typeof first?.message === "string" ? `: ${first.message}` : "";
}
