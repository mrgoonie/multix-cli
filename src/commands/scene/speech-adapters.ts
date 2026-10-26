/**
 * Thin speech adapters for scene rendering. Each one reuses its provider's
 * existing client and request builder, states what a model accepts (length
 * limit, SSML breaks, audio tags, neighbouring-text context, language,
 * delivery style) so bad input is rejected before a request is paid for, and
 * returns audio bytes; it never retries a paid request or switches provider.
 * Raw PCM is wrapped in a WAV header so editors can open every stem.
 */

import { ConfigError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import { apiPostBinary, requireElevenLabsKey } from "../../providers/elevenlabs/client.js";
import {
  ELEVENLABS_OUTPUT_FORMATS,
  ELEVENLABS_TTS_MODELS,
  ttsModelCaps,
} from "../../providers/elevenlabs/models.js";
import { synthesizeGeminiSpeech, wrapPcmInWav } from "../../providers/gemini/generators/speech.js";
import { listGeminiKeys } from "../../providers/gemini/key-pool.js";
import {
  GEMINI_INTERACTIONS_TTS_MODELS,
  GEMINI_TTS_MODELS,
  GEMINI_TTS_VOICES,
  TTS_PCM_SAMPLE_RATE,
  isVoiceAllowedForModel,
} from "../../providers/gemini/voices.js";
import { postOpenAIBinary, requireOpenAIKey } from "../../providers/openai/client.js";
import {
  OPENAI_TTS_OUTPUT_FORMATS,
  OPENAI_TTS_VOICES,
  type OpenAITtsOutputFormat,
} from "../../providers/openai/models.js";
import { buildSpeechBody } from "../../providers/openai/openai-audio.js";
import type { SettingValue, VoiceProfile } from "./voice-profile.js";

export const SCENE_PROVIDERS = ["gemini", "openai", "elevenlabs"] as const;
export type SceneProvider = (typeof SCENE_PROVIDERS)[number];

export interface ModelLimits {
  /** Longest line (Unicode code points) sent in one request. */
  maxChars: number;
  /** Bracketed audio tags such as [whispers]. */
  audioTags: boolean;
  /** SSML <break time="..."/> tags. */
  ssmlBreaks: boolean;
  /** previous/next text for continuity between lines. */
  context: boolean;
  /** A language code is sent with the request. */
  language: boolean;
  /** Free-text delivery direction (profile style, per-line direction). */
  style: boolean;
}

export interface SynthesisRequest {
  text: string;
  profile: VoiceProfile;
  /** Profile style and per-line direction, joined. */
  style?: string;
  previousText?: string;
  nextText?: string;
}

export interface SynthesizedAudio {
  bytes: Buffer;
  ext: string;
  sampleRate?: number;
}

export interface SpeechAdapter {
  keyEnv: string;
  formats: readonly string[];
  limits(model: string): ModelLimits;
  profileErrors(profile: VoiceProfile): string[];
  /** Everything the request carries besides the text, for the cache key. */
  requestParams(req: Omit<SynthesisRequest, "text">): Record<string, unknown>;
  /** Throws a ConfigError naming the env var when the key is missing. */
  requireKey(): void;
  synthesize(req: SynthesisRequest, logger?: Logger): Promise<SynthesizedAudio>;
}

function numberSetting(
  settings: Record<string, SettingValue>,
  name: string,
  min: number,
  max: number,
  errors: string[],
): void {
  const v = settings[name];
  if (v === undefined) return;
  if (typeof v !== "number" || Number.isNaN(v) || v < min || v > max) {
    errors.push(`settings.${name} must be a number from ${min} to ${max}`);
  }
}

function unknownSettings(
  settings: Record<string, SettingValue> | undefined,
  allowed: readonly string[],
  provider: string,
): string[] {
  return Object.keys(settings ?? {})
    .filter((k) => !allowed.includes(k))
    .map((k) =>
      allowed.length
        ? `settings.${k} is not supported by ${provider}; allowed: ${allowed.join(", ")}`
        : `settings.${k}: ${provider} takes no settings`,
    );
}

function definedEntries(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

const OPENAI_TTS_MODEL = /^(gpt-4o-mini-tts(-\d{4}-\d{2}-\d{2})?|tts-1|tts-1-hd)$/;
const OPENAI_SCENE_FORMATS = OPENAI_TTS_OUTPUT_FORMATS;

const openai: SpeechAdapter = {
  keyEnv: "OPENAI_API_KEY",
  formats: OPENAI_SCENE_FORMATS,
  limits: (model) => ({
    maxChars: 4096,
    audioTags: false,
    ssmlBreaks: false,
    context: false,
    language: false,
    style: model.startsWith("gpt-"),
  }),
  profileErrors(p) {
    const errors: string[] = [];
    if (!OPENAI_TTS_MODEL.test(p.model)) {
      errors.push(
        `model "${p.model}" is not an OpenAI TTS model (gpt-4o-mini-tts, tts-1, tts-1-hd)`,
      );
    }
    if (!(OPENAI_TTS_VOICES as readonly string[]).includes(p.voice)) {
      errors.push(`voice "${p.voice}" is not an OpenAI voice (${OPENAI_TTS_VOICES.join(", ")})`);
    }
    if (!(OPENAI_SCENE_FORMATS as readonly string[]).includes(p.format)) {
      errors.push(`format must be one of: ${OPENAI_SCENE_FORMATS.join(", ")}`);
    }
    if (p.style && !this.limits(p.model).style) errors.push(`${p.model} takes no style`);
    if (p.context) errors.push("context: OpenAI TTS takes no previous/next text");
    errors.push(...unknownSettings(p.settings, ["speed"], "OpenAI"));
    numberSetting(p.settings ?? {}, "speed", 0.25, 4, errors);
    return errors;
  },
  requestParams: ({ profile, style }) =>
    definedEntries({
      voice: profile.voice,
      format: profile.format,
      instructions: style,
      speed: profile.settings?.speed,
    }),
  requireKey: () => void requireOpenAIKey(),
  async synthesize(req) {
    const format = req.profile.format as OpenAITtsOutputFormat;
    const body = buildSpeechBody({
      text: req.text,
      model: req.profile.model,
      voice: req.profile.voice,
      outputFormat: format,
      instructions: req.style,
    });
    if (req.profile.settings?.speed !== undefined) body.speed = req.profile.settings.speed;
    const bytes = await postOpenAIBinary("/audio/speech", body, requireOpenAIKey());
    // OpenAI audio is 24 kHz; raw PCM is 16-bit little-endian mono.
    if (format === "pcm") {
      return { bytes: wrapPcmInWav(bytes, 24_000, 1, 16), ext: "wav", sampleRate: 24_000 };
    }
    return { bytes, ext: format, sampleRate: 24_000 };
  },
};

// ── ElevenLabs ────────────────────────────────────────────────────────────────

/** mp3 and pcm only: telephony μ-law is not an editing format. */
const ELEVENLABS_SCENE_FORMATS = ELEVENLABS_OUTPUT_FORMATS.filter((f) => !f.startsWith("ulaw"));
const ELEVENLABS_SETTINGS = [
  "stability",
  "similarity_boost",
  "style",
  "use_speaker_boost",
  "speed",
  "seed",
] as const;
const ELEVENLABS_VOICE_ID = /^[A-Za-z0-9]{20}$/;

function elevenlabsSampleRate(format: string): number | undefined {
  const rate = Number(format.split("_")[1]);
  return Number.isFinite(rate) ? rate : undefined;
}

const elevenlabs: SpeechAdapter = {
  keyEnv: "ELEVENLABS_API_KEY",
  formats: ELEVENLABS_SCENE_FORMATS,
  limits: (model) => {
    const caps = ttsModelCaps(model);
    return {
      maxChars: caps?.maxChars ?? 5_000,
      audioTags: caps?.audioTags ?? false,
      // Tag-driven models (v3, v4) take audio tags instead of SSML breaks.
      ssmlBreaks: caps?.ssmlBreak ?? false,
      context: caps?.contextText ?? false,
      // A model that does not enforce language_code (multilingual_v2) would take
      // the code without effect, so profileErrors rejects a language for it.
      language: caps?.languageCode ?? false,
      style: false,
    };
  },
  profileErrors(p) {
    const errors: string[] = [];
    if (!(ELEVENLABS_TTS_MODELS as readonly string[]).includes(p.model)) {
      errors.push(
        `model "${p.model}" is not an ElevenLabs TTS model (${ELEVENLABS_TTS_MODELS.join(", ")})`,
      );
    }
    if (!ELEVENLABS_VOICE_ID.test(p.voice)) {
      errors.push(
        `voice "${p.voice}" is not an ElevenLabs voice id (20 letters/digits; see multix elevenlabs voices)`,
      );
    }
    if (!(ELEVENLABS_SCENE_FORMATS as readonly string[]).includes(p.format)) {
      errors.push(`format must be one of: ${ELEVENLABS_SCENE_FORMATS.join(", ")}`);
    }
    if (p.style) {
      errors.push(
        "style: ElevenLabs takes no free-text style; use settings.style (0..1) or v3 audio tags",
      );
    }
    if (p.context && !this.limits(p.model).context) {
      errors.push(`context: ${p.model} takes no previous/next text`);
    }
    if (p.language && ttsModelCaps(p.model) && !this.limits(p.model).language) {
      const enforcing = ELEVENLABS_TTS_MODELS.filter((m) => ttsModelCaps(m)?.languageCode);
      errors.push(
        `language: ${p.model} does not enforce language_code, so the text's own language decides; drop language or use ${enforcing.join(", ")}`,
      );
    }
    const s = p.settings ?? {};
    errors.push(...unknownSettings(s, ELEVENLABS_SETTINGS, "ElevenLabs"));
    for (const name of ["stability", "similarity_boost", "style"])
      numberSetting(s, name, 0, 1, errors);
    numberSetting(s, "speed", 0.7, 1.2, errors);
    // Settings a model ignores would be paid for without effect.
    const caps = ttsModelCaps(p.model);
    if (caps && !caps.style && s.style !== undefined) {
      errors.push(`settings.style is ignored by ${p.model}`);
    }
    if (caps && !caps.speakerBoost && s.use_speaker_boost !== undefined) {
      errors.push(`settings.use_speaker_boost is ignored by ${p.model}`);
    }
    numberSetting(s, "seed", 0, 4_294_967_295, errors);
    if (s.seed !== undefined && !Number.isInteger(s.seed))
      errors.push("settings.seed must be an integer");
    if (s.use_speaker_boost !== undefined && typeof s.use_speaker_boost !== "boolean") {
      errors.push("settings.use_speaker_boost must be true or false");
    }
    return errors;
  },
  requestParams({ profile, previousText, nextText }) {
    const limits = this.limits(profile.model);
    return definedEntries({
      voice: profile.voice,
      format: profile.format,
      settings:
        profile.settings && Object.keys(profile.settings).length ? profile.settings : undefined,
      language_code:
        limits.language && profile.language ? profile.language.split("-")[0] : undefined,
      previous_text: profile.context && limits.context ? previousText : undefined,
      next_text: profile.context && limits.context ? nextText : undefined,
    });
  },
  requireKey: () => void requireElevenLabsKey(),
  async synthesize(req) {
    const params = this.requestParams(req);
    const { seed, ...voiceSettings } = (params.settings ?? {}) as Record<string, SettingValue>;
    const payload: Record<string, unknown> = { text: req.text, model_id: req.profile.model };
    if (Object.keys(voiceSettings).length) payload.voice_settings = voiceSettings;
    if (seed !== undefined) payload.seed = seed;
    for (const key of ["language_code", "previous_text", "next_text"]) {
      if (params[key] !== undefined) payload[key] = params[key];
    }
    const format = req.profile.format;
    const bytes = await apiPostBinary(
      `text-to-speech/${encodeURIComponent(req.profile.voice)}`,
      payload,
      requireElevenLabsKey(),
      { query: { output_format: format } },
    );
    const sampleRate = elevenlabsSampleRate(format);
    if (format.startsWith("pcm")) {
      return { bytes: wrapPcmInWav(bytes, sampleRate ?? 24_000, 1, 16), ext: "wav", sampleRate };
    }
    return { bytes, ext: "mp3", sampleRate };
  },
};

// ── Gemini ────────────────────────────────────────────────────────────────────

const gemini: SpeechAdapter = {
  keyEnv: "GEMINI_API_KEY",
  formats: ["wav"],
  limits: (model) => ({
    maxChars: 4_000,
    audioTags: false,
    ssmlBreaks: false,
    context: false,
    language: false,
    style: GEMINI_INTERACTIONS_TTS_MODELS.has(model),
  }),
  profileErrors(p) {
    const errors: string[] = [];
    if (!GEMINI_TTS_MODELS.has(p.model)) {
      errors.push(
        `model "${p.model}" is not a Gemini TTS model (${[...GEMINI_TTS_MODELS].join(", ")})`,
      );
    } else if (!isVoiceAllowedForModel(p.voice, p.model)) {
      errors.push(
        `voice "${p.voice}" is not valid for ${p.model} (${GEMINI_TTS_VOICES.join(", ")})`,
      );
    }
    if (p.format !== "wav") errors.push("format must be wav");
    if (p.style && !this.limits(p.model).style) {
      errors.push(`style needs a Gemini 3.8 TTS model; ${p.model} reads directions aloud`);
    }
    if (p.context) errors.push("context: Gemini TTS takes no previous/next text");
    errors.push(...unknownSettings(p.settings, [], "Gemini"));
    return errors;
  },
  requestParams: ({ profile, style }) =>
    definedEntries({ voice: profile.voice, format: profile.format, style }),
  requireKey() {
    if (listGeminiKeys().length === 0) {
      throw new ConfigError(
        "GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey",
      );
    }
  },
  async synthesize(req, logger) {
    const audio = await synthesizeGeminiSpeech({
      text: req.text,
      model: req.profile.model,
      voice: req.profile.voice,
      style: req.style,
      outputFormat: "wav",
      logger,
    });
    return { bytes: audio.bytes, ext: "wav", sampleRate: TTS_PCM_SAMPLE_RATE };
  },
};

const ADAPTERS: Record<SceneProvider, SpeechAdapter> = { gemini, openai, elevenlabs };

export function adapterFor(provider: SceneProvider): SpeechAdapter {
  return ADAPTERS[provider];
}
