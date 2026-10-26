/**
 * Builds and validates the ElevenLabs text-to-speech request body per model
 * (runtime-neutral: no node:* imports). The API accepts voice settings a model
 * does not use and drops them silently (e.g. style or speed on eleven_v4), so
 * the CLI rejects them here instead of letting a run quietly ignore a flag.
 */

import { ValidationError } from "../../core/errors.js";
import {
  ELEVENLABS_TTS_CAPS,
  ELEVENLABS_TTS_MODELS,
  type ElevenLabsTtsModel,
  type TtsModelCaps,
  type VoiceSettingKey,
} from "./models.js";

export type VoiceSettings = Partial<Record<VoiceSettingKey, number | boolean>>;

export interface TtsInput {
  text: string;
  model: string;
  /** Only the settings the user passed; model defaults are added here. */
  settings: VoiceSettings;
  languageCode?: string;
  seed?: number;
  previousText?: string;
  nextText?: string;
}

export interface TtsRequest {
  payload: Record<string, unknown>;
  warnings: string[];
}

export const SETTING_FLAGS: Record<VoiceSettingKey, string> = {
  stability: "--stability",
  similarity_boost: "--similarity-boost",
  style: "--style",
  use_speaker_boost: "--speaker-boost/--no-speaker-boost",
  speed: "--speed",
  clone_strength: "--clone-strength",
};

const RANGES: Partial<Record<VoiceSettingKey, [number, number]>> = {
  stability: [0, 1],
  similarity_boost: [0, 1],
  style: [0, 1],
  clone_strength: [0, 1],
  // The range the v2 models enforce; v3 and v4 ignore speed.
  speed: [0.7, 1.2],
};

const MAX_SEED = 4_294_967_295;
const AUDIO_TAG = /\[[a-z][^\]\n]{0,40}\]/i;
const SSML_TAG = /<(break|phoneme)\b/i;

export function ttsCaps(model: string): TtsModelCaps | undefined {
  return (ELEVENLABS_TTS_MODELS as readonly string[]).includes(model)
    ? ELEVENLABS_TTS_CAPS[model as ElevenLabsTtsModel]
    : undefined;
}

/** Parse a numeric CLI flag, rejecting non-numbers instead of sending NaN. */
export function parseSetting(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) {
    throw new ValidationError(`${flag} must be a number, got "${raw}"`);
  }
  return n;
}

function modelsWith(key: VoiceSettingKey): string[] {
  return ELEVENLABS_TTS_MODELS.filter((m) => ELEVENLABS_TTS_CAPS[m].settings.includes(key));
}

export function buildTtsRequest(input: TtsInput): TtsRequest {
  const { text, model } = input;
  const warnings: string[] = [];
  const caps = ttsCaps(model);

  for (const [key, value] of Object.entries(input.settings) as [VoiceSettingKey, unknown][]) {
    const range = RANGES[key];
    if (range && typeof value === "number" && (value < range[0] || value > range[1])) {
      throw new ValidationError(
        `${SETTING_FLAGS[key]} must be between ${range[0]} and ${range[1]}, got ${value}`,
      );
    }
    if (caps && !caps.settings.includes(key)) {
      throw new ValidationError(
        `${SETTING_FLAGS[key]} is not supported by ${model} (it would be silently ignored). ` +
          `Supported: ${caps.settings.map((k) => SETTING_FLAGS[k]).join(", ")}. ` +
          `Models that use it: ${modelsWith(key).join(", ") || "none"}.`,
      );
    }
  }
  if (
    input.seed !== undefined &&
    (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > MAX_SEED)
  ) {
    throw new ValidationError(`--seed must be an integer 0..${MAX_SEED}, got ${input.seed}`);
  }

  if (caps) {
    if (text.length > caps.maxChars) {
      throw new ValidationError(
        `Text is ${text.length} characters; ${model} accepts at most ${caps.maxChars} per request. Split the text and pass --previous-text/--next-text for continuity.`,
      );
    }
    if (!caps.audioTags && AUDIO_TAG.test(text)) {
      warnings.push(
        `${model} does not interpret audio tags like [whispering]; they may be read aloud. Use eleven_v4, eleven_v4_turbo or eleven_v3 for audio tags.`,
      );
    }
    if (!caps.ssml && SSML_TAG.test(text)) {
      warnings.push(
        `${model} does not support SSML <break>/<phoneme> tags; use audio tags or punctuation for pauses.`,
      );
    }
  } else {
    warnings.push(
      `Unknown ElevenLabs model "${model}": sending it as-is with only the voice settings you passed. Run \`multix elevenlabs models\` to see the live catalog.`,
    );
  }

  const voiceSettings = { ...(caps?.defaults ?? {}), ...input.settings };
  const payload: Record<string, unknown> = { text, model_id: model };
  if (Object.keys(voiceSettings).length > 0) payload.voice_settings = voiceSettings;
  if (input.languageCode) payload.language_code = input.languageCode;
  if (input.seed !== undefined) payload.seed = input.seed;
  if (input.previousText) payload.previous_text = input.previousText;
  if (input.nextText) payload.next_text = input.nextText;
  return { payload, warnings };
}
