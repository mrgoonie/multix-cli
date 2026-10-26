/**
 * Build the /text-to-speech request body for one model (runtime-neutral).
 * Options the model cannot honour are rejected when the user set them to a
 * value that would change the audio, and dropped with a warning when they
 * would be a no-op, so nothing the user asked for is ignored silently.
 */

import { ValidationError } from "../../core/errors.js";
import { ELEVENLABS_TTS_MODEL_CAPS, type TtsModelCaps, ttsModelCaps } from "./models.js";

export interface TtsInput {
  text: string;
  model: string;
  /** Raw CLI strings; undefined means the user did not set the option. */
  stability?: string;
  similarityBoost?: string;
  style?: string;
  /** Set only when the user passed --no-speaker-boost (false) explicitly. */
  speakerBoost?: boolean;
  /** Professional Voice Clone adherence (v4 family only). */
  cloneStrength?: string;
  languageCode?: string;
  seed?: string;
  previousText?: string;
  nextText?: string;
}

export interface TtsRequestPlan {
  payload: Record<string, unknown>;
  warnings: string[];
}

export const TTS_VOICE_DEFAULTS = { stability: 0.5, similarityBoost: 0.75, style: 0 } as const;

const AUDIO_TAG = /\[[a-z][a-z ,'-]{0,40}\]/i;
const SSML_BREAK = /<\s*break\b/i;
const SSML_PHONEME = /<\s*phoneme\b/i;
/** ElevenLabs voice IDs are 20 letters and digits; this also keeps `.`/`..` out of the URL path. */
const VOICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SEED = 4_294_967_295;

function modelsWith(pick: (caps: TtsModelCaps) => boolean): string {
  return Object.entries(ELEVENLABS_TTS_MODEL_CAPS)
    .filter(([, caps]) => pick(caps))
    .map(([id]) => id)
    .join(", ");
}

function unitInterval(flag: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n < 0 || n > 1) {
    throw new ValidationError(`${flag} must be a number from 0 to 1 (got "${raw}")`);
  }
  return n;
}

/** Rejects a voice ID that is not one, before it becomes a URL path segment. */
export function checkVoiceId(voice: string): void {
  if (!VOICE_ID.test(voice)) {
    throw new ValidationError(
      `--voice must be an ElevenLabs voice ID (letters, digits, "_" or "-"; got "${voice}"). List voices with: multix elevenlabs voices list`,
    );
  }
}

export function buildTtsRequest(input: TtsInput): TtsRequestPlan {
  const { text, model } = input;
  const caps = ttsModelCaps(model);
  const warnings: string[] = [];
  // Code points, as ElevenLabs counts and bills them: an astral character such
  // as 𠀀 is one character, not two UTF-16 units.
  const chars = [...text].length;

  if (!caps) {
    warnings.push(
      `Model "${model}" is not in multix's ElevenLabs capability table; options are sent as given and not checked. List live models with: multix elevenlabs models`,
    );
  } else if (chars > caps.maxChars) {
    const higher = Object.entries(ELEVENLABS_TTS_MODEL_CAPS)
      .filter(([, c]) => c.maxChars >= chars)
      .map(([id, c]) => `${id} (${c.maxChars})`);
    throw new ValidationError(
      `${model} takes at most ${caps.maxChars} characters per request (got ${chars}). Split the text${higher.length ? `, or use a model with a higher limit: ${higher.join(", ")}` : ""}.`,
    );
  }

  const voiceSettings: Record<string, unknown> = {
    stability: unitInterval("--stability", input.stability, TTS_VOICE_DEFAULTS.stability),
    similarity_boost: unitInterval(
      "--similarity-boost",
      input.similarityBoost,
      TTS_VOICE_DEFAULTS.similarityBoost,
    ),
  };

  const style = unitInterval("--style", input.style, TTS_VOICE_DEFAULTS.style);
  if (!caps || caps.style) {
    voiceSettings.style = style;
  } else if (input.style !== undefined) {
    if (style > 0) {
      throw new ValidationError(
        `${model} has no style control, so --style ${input.style} would be ignored. Drop --style, or use a model that supports it: ${modelsWith((c) => c.style)}.`,
      );
    }
    warnings.push(`${model} has no style control; --style ${input.style} was not sent.`);
  }

  if (!caps || caps.speakerBoost) {
    voiceSettings.use_speaker_boost = input.speakerBoost ?? true;
  } else if (input.speakerBoost === false) {
    warnings.push(`${model} has no speaker boost; --no-speaker-boost has no effect.`);
  }

  if (input.cloneStrength !== undefined) {
    const strength = unitInterval("--clone-strength", input.cloneStrength, 0);
    if (caps && !caps.cloneStrength) {
      throw new ValidationError(
        `${model} does not accept --clone-strength (the API answers 400 unsupported_model). Drop it, or use: ${modelsWith((c) => c.cloneStrength)}.`,
      );
    }
    voiceSettings.clone_strength = strength;
  }

  const payload: Record<string, unknown> = { text, model_id: model, voice_settings: voiceSettings };

  if (input.languageCode) payload.language_code = input.languageCode;

  if (input.seed !== undefined) {
    const seed = Number(input.seed);
    if (!/^\d+$/.test(input.seed.trim()) || seed > MAX_SEED) {
      throw new ValidationError(
        `--seed must be an integer from 0 to ${MAX_SEED} (got "${input.seed}")`,
      );
    }
    payload.seed = seed;
  }

  if (input.previousText || input.nextText) {
    if (caps && !caps.contextText) {
      throw new ValidationError(
        `${model} does not accept --previous-text/--next-text (the API answers 400 unsupported_model). Drop them, or use a model that does: ${modelsWith((c) => c.contextText)}.`,
      );
    }
    if (input.previousText) payload.previous_text = input.previousText;
    if (input.nextText) payload.next_text = input.nextText;
  }

  if (caps && !caps.audioTags && AUDIO_TAG.test(text)) {
    warnings.push(
      `${model} reads bracketed audio tags such as [whispering] aloud. Models that perform them: ${modelsWith((c) => c.audioTags)}.`,
    );
  }
  if (caps && !caps.ssmlBreak && SSML_BREAK.test(text)) {
    warnings.push(
      `${model} skips SSML <break> tags without pausing; use punctuation (an ellipsis or a dash) instead. Models that pause for <break>: ${modelsWith((c) => c.ssmlBreak)}.`,
    );
  }
  if (caps && !caps.ssmlPhoneme && SSML_PHONEME.test(text)) {
    warnings.push(
      `${model} drops words wrapped in SSML <phoneme> tags instead of speaking them. Models that speak <phoneme>: ${modelsWith((c) => c.ssmlPhoneme)}.`,
    );
  }

  return { payload, warnings };
}
