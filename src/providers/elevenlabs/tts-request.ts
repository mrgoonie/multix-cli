/**
 * Builds and checks a /text-to-speech request against what the chosen model
 * accepts (see TTS_MODEL_CAPABILITIES). Runtime-neutral: no I/O, no `node:*`.
 *
 * - Verified models: an option the model does not use is reported. Strict
 *   models (Eleven v4) reject it; the older models keep their previous payload
 *   and only warn, so existing invocations behave as before.
 * - Requests the API would refuse anyway (text too long, previous/next text on
 *   eleven_v3, malformed values) fail before any credits are spent.
 * - Unknown model ids are sent as before, with a warning that nothing was checked.
 * - Malformed numbers (voice settings, seed) and voice ids always fail: they
 *   were sent as null or into the URL path before.
 */

import { ValidationError } from "../../core/errors.js";
import {
  ELEVENLABS_TTS_MODELS,
  ELEVENLABS_TTS_OUTPUT_FORMATS,
  TTS_MODEL_CAPABILITIES,
  type VoiceSettingKey,
  ttsModelCapabilities,
} from "./models.js";

export interface TtsOptions {
  text: string;
  voice: string;
  model: string;
  format: string;
  stability: string;
  similarityBoost: string;
  style: string;
  speakerBoost: boolean;
  speed?: string;
  cloneStrength?: string;
  languageCode?: string;
  seed?: string;
  previousText?: string;
  nextText?: string;
  timestamps?: boolean;
}

/** Option keys of TtsOptions the caller set; the rest hold CLI defaults. */
export type ExplicitOptions = ReadonlySet<keyof TtsOptions>;

export interface TtsRequest {
  /** Path under /v1, e.g. `text-to-speech/<voice>/with-timestamps`. */
  endpoint: string;
  query: { output_format: string };
  payload: Record<string, unknown>;
  /** Non-fatal incompatibilities, for stderr. */
  warnings: string[];
}

const SETTING_FLAG: Record<VoiceSettingKey, string> = {
  stability: "--stability",
  similarity_boost: "--similarity-boost",
  style: "--style",
  use_speaker_boost: "--no-speaker-boost",
  speed: "--speed",
  clone_strength: "--clone-strength",
};
const SETTING_OPTION: Record<VoiceSettingKey, keyof TtsOptions> = {
  stability: "stability",
  similarity_boost: "similarityBoost",
  style: "style",
  use_speaker_boost: "speakerBoost",
  speed: "speed",
  clone_strength: "cloneStrength",
};

const VOICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LANGUAGE_CODE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;
const AUDIO_TAG = /\[[a-z][a-z ,'-]{0,40}\]/i;
const SSML_TAG = /<\s*(break|phoneme)\b/i;
const MAX_SEED = 4_294_967_295;

function unit(flag: string, raw: string): number {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n < 0 || n > 1) {
    throw new ValidationError(`${flag} must be a number from 0 to 1, got "${raw}"`);
  }
  return n;
}

function speedValue(raw: string): number {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n < 0.7 || n > 1.2) {
    throw new ValidationError(`--speed must be a number from 0.7 to 1.2, got "${raw}"`);
  }
  return n;
}

function modelsWhere(test: (m: (typeof ELEVENLABS_TTS_MODELS)[number]) => boolean): string {
  return ELEVENLABS_TTS_MODELS.filter(test).join(", ");
}

export function buildTtsRequest(o: TtsOptions, explicit: ExplicitOptions): TtsRequest {
  const warnings: string[] = [];
  const caps = ttsModelCapabilities(o.model);
  const report = (message: string) => {
    if (caps?.strict) throw new ValidationError(message);
    warnings.push(message);
  };

  if (!o.text) throw new ValidationError("Either --text or --prompt is required");
  if (!VOICE_ID.test(o.voice)) {
    throw new ValidationError(
      `--voice must be an ElevenLabs voice ID (letters and digits), got "${o.voice}". List voices with: multix elevenlabs voices list`,
    );
  }
  if (!(ELEVENLABS_TTS_OUTPUT_FORMATS as readonly string[]).includes(o.format)) {
    report(`Unknown --format "${o.format}". Valid: ${ELEVENLABS_TTS_OUTPUT_FORMATS.join(", ")}`);
  }
  if (!caps) {
    warnings.push(
      `${o.model} is not a verified ElevenLabs TTS model (${ELEVENLABS_TTS_MODELS.join(", ")}); options are sent unchecked.`,
    );
  }

  // Voice settings. Unknown and older models keep the full legacy object;
  // strict models get only the settings they use.
  const settings: Record<string, unknown> = {};
  const values: Record<VoiceSettingKey, () => unknown> = {
    stability: () => unit("--stability", o.stability),
    similarity_boost: () => unit("--similarity-boost", o.similarityBoost),
    style: () => unit("--style", o.style),
    use_speaker_boost: () => o.speakerBoost,
    speed: () => speedValue(o.speed ?? ""),
    clone_strength: () => unit("--clone-strength", o.cloneStrength ?? ""),
  };
  for (const key of Object.keys(values) as VoiceSettingKey[]) {
    const isExplicit = explicit.has(SETTING_OPTION[key]);
    if (key === "speed" && o.speed === undefined) continue;
    if (key === "clone_strength") {
      if (o.cloneStrength === undefined) continue;
      if (caps && !caps.voiceSettings.includes(key)) {
        throw new ValidationError(
          `--clone-strength applies only to ${modelsWhere((m) => TTS_MODEL_CAPABILITIES[m].voiceSettings.includes(key))} (Professional Voice Clones fine-tuned for v4); ${o.model} does not use it.`,
        );
      }
      settings[key] = values[key]();
      continue;
    }
    if (caps && !caps.voiceSettings.includes(key)) {
      if (isExplicit) {
        report(
          `${SETTING_FLAG[key]} is not used by ${o.model} (it uses ${caps.voiceSettings.map((k) => SETTING_FLAG[k]).join(", ")}). Drop ${SETTING_FLAG[key]}, or use a model that supports it: ${modelsWhere((m) => TTS_MODEL_CAPABILITIES[m].voiceSettings.includes(key))}.`,
        );
      }
      if (caps.strict) continue;
    }
    settings[key] = values[key]();
  }

  const payload: Record<string, unknown> = {
    text: o.text,
    model_id: o.model,
    voice_settings: settings,
  };

  // Code points, not UTF-16 units: an emoji is one character to the API.
  const chars = [...o.text].length;
  if (caps && chars > caps.maxChars) {
    throw new ValidationError(
      `Text is ${chars} characters; ${o.model} accepts at most ${caps.maxChars} per request. Split the text and pass --previous-text/--next-text for continuity.`,
    );
  }

  if (o.languageCode !== undefined) {
    if (!LANGUAGE_CODE.test(o.languageCode)) {
      report(
        `--language-code should be an ISO 639 code such as "en" or "vi", got "${o.languageCode}"`,
      );
    }
    if (caps && !caps.languageCode) {
      report(
        `--language-code is ignored by ${o.model}. Drop it, or use a model that honours it: ${modelsWhere((m) => TTS_MODEL_CAPABILITIES[m].languageCode)}.`,
      );
    }
    payload.language_code = o.languageCode;
  }

  if (o.seed !== undefined) {
    const seed = Number(o.seed);
    if (!/^\d+$/.test(o.seed.trim()) || seed > MAX_SEED) {
      throw new ValidationError(`--seed must be an integer from 0 to ${MAX_SEED}, got "${o.seed}"`);
    }
    payload.seed = seed;
  }

  if (o.previousText || o.nextText) {
    if (caps && !caps.contextText) {
      throw new ValidationError(
        `--previous-text/--next-text are not supported by ${o.model} (the API rejects them). Drop them, or use: ${modelsWhere((m) => TTS_MODEL_CAPABILITIES[m].contextText)}.`,
      );
    }
    if (o.previousText) payload.previous_text = o.previousText;
    if (o.nextText) payload.next_text = o.nextText;
  }

  if (caps && !caps.audioTags && AUDIO_TAG.test(o.text)) {
    warnings.push(
      `${o.model} does not interpret audio tags such as [whispers]; they may be read aloud. Use ${modelsWhere((m) => TTS_MODEL_CAPABILITIES[m].audioTags)} for audio tags.`,
    );
  }
  if (caps && !caps.ssml && SSML_TAG.test(o.text)) {
    warnings.push(
      `${o.model} does not support SSML <break>/<phoneme> tags; use punctuation or audio tags for pauses${o.model.startsWith("eleven_v4") ? ", and IPA between slashes (/.../) for pronunciation" : ""}.`,
    );
  }

  const voicePath = `text-to-speech/${o.voice}`;
  return {
    endpoint: o.timestamps ? `${voicePath}/with-timestamps` : voicePath,
    query: { output_format: o.format },
    payload,
    warnings,
  };
}
