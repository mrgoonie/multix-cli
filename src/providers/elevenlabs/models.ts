/**
 * ElevenLabs constants — model IDs, output formats, defaults.
 */

export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";

export const ELEVENLABS_TTS_MODELS = [
  "eleven_v4",
  "eleven_v4_turbo",
  "eleven_v3",
  "eleven_v3_conversational",
  "eleven_multilingual_v2",
  "eleven_flash_v2_5",
  "eleven_flash_v2",
  "eleven_turbo_v2_5",
  "eleven_turbo_v2",
] as const;

export type ElevenLabsTtsModel = (typeof ELEVENLABS_TTS_MODELS)[number];

export const ELEVENLABS_STT_MODELS = ["scribe_v1", "scribe_v1_experimental"] as const;

/** Output format query string accepted by /text-to-speech and /sound-generation. */
export const ELEVENLABS_OUTPUT_FORMATS = [
  "mp3_22050_32",
  "mp3_44100_32",
  "mp3_44100_64",
  "mp3_44100_96",
  "mp3_44100_128",
  "mp3_44100_192",
  "pcm_8000",
  "pcm_16000",
  "pcm_22050",
  "pcm_24000",
  "pcm_44100",
  "ulaw_8000",
] as const;

export type ElevenLabsOutputFormat = (typeof ELEVENLABS_OUTPUT_FORMATS)[number];

/** Output formats /text-to-speech accepts (OpenAPI enum; wider than sfx/music/STS). */
export const ELEVENLABS_TTS_OUTPUT_FORMATS = [
  ...ELEVENLABS_OUTPUT_FORMATS,
  "mp3_24000_48",
  "pcm_32000",
  "pcm_48000",
  "wav_8000",
  "wav_16000",
  "wav_22050",
  "wav_24000",
  "wav_32000",
  "wav_44100",
  "wav_48000",
  "opus_48000_32",
  "opus_48000_64",
  "opus_48000_96",
  "opus_48000_128",
  "opus_48000_192",
  "alaw_8000",
] as const;

export type VoiceSettingKey =
  | "stability"
  | "similarity_boost"
  | "style"
  | "use_speaker_boost"
  | "speed"
  | "clone_strength";

export interface TtsModelCaps {
  /** Characters per request (GET /v1/models maximum_text_length_per_request). */
  maxChars: number;
  /** voice_settings fields the model honours; others are silently dropped by the API. */
  settings: readonly VoiceSettingKey[];
  /** Understands inline audio tags such as [whispering]. */
  audioTags: boolean;
  /** Understands SSML <break>/<phoneme> tags. */
  ssml: boolean;
  /**
   * Settings sent when the user passes none: the CLI's historical overrides,
   * kept for the models that had them. v4 sends only what the user passes, so
   * the voice's stored settings apply.
   */
  defaults: Partial<Record<VoiceSettingKey, number | boolean>>;
}

const LEGACY_DEFAULTS = { stability: 0.5, similarity_boost: 0.75 } as const;

/**
 * Per-model TTS capabilities, from the live GET /v1/models catalog
 * (can_use_style, can_use_speaker_boost, maximum_text_length_per_request) and
 * the Eleven v4 docs (Stability, Similarity and Clone Strength only; no Style,
 * Speed or SSML). https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4
 * Speed is v2-family only: those models reject speed outside 0.7..1.2, while
 * v3 and v4 accept any speed and ignore it.
 */
export const ELEVENLABS_TTS_CAPS: Record<ElevenLabsTtsModel, TtsModelCaps> = {
  eleven_v4: {
    maxChars: 10_000,
    settings: ["stability", "similarity_boost", "clone_strength"],
    audioTags: true,
    ssml: false,
    defaults: {},
  },
  eleven_v4_turbo: {
    maxChars: 10_000,
    settings: ["stability", "similarity_boost", "clone_strength"],
    audioTags: true,
    ssml: false,
    defaults: {},
  },
  eleven_v3: {
    maxChars: 5_000,
    settings: ["stability", "similarity_boost"],
    audioTags: true,
    ssml: false,
    defaults: LEGACY_DEFAULTS,
  },
  eleven_v3_conversational: {
    maxChars: 5_000,
    settings: ["stability", "similarity_boost", "use_speaker_boost"],
    audioTags: true,
    ssml: false,
    defaults: { ...LEGACY_DEFAULTS, use_speaker_boost: true },
  },
  eleven_multilingual_v2: {
    maxChars: 10_000,
    settings: ["stability", "similarity_boost", "style", "use_speaker_boost", "speed"],
    audioTags: false,
    ssml: true,
    defaults: { ...LEGACY_DEFAULTS, style: 0, use_speaker_boost: true },
  },
  eleven_flash_v2_5: {
    maxChars: 40_000,
    settings: ["stability", "similarity_boost", "speed"],
    audioTags: false,
    ssml: true,
    defaults: LEGACY_DEFAULTS,
  },
  eleven_flash_v2: {
    maxChars: 30_000,
    settings: ["stability", "similarity_boost", "speed"],
    audioTags: false,
    ssml: true,
    defaults: LEGACY_DEFAULTS,
  },
  eleven_turbo_v2_5: {
    maxChars: 40_000,
    settings: ["stability", "similarity_boost", "speed"],
    audioTags: false,
    ssml: true,
    defaults: LEGACY_DEFAULTS,
  },
  eleven_turbo_v2: {
    maxChars: 30_000,
    settings: ["stability", "similarity_boost", "speed"],
    audioTags: false,
    ssml: true,
    defaults: LEGACY_DEFAULTS,
  },
};

/**
 * Verified voice IDs from the ElevenLabs conversational voice design guide.
 * https://elevenlabs.io/docs/eleven-agents/customization/voice/best-practices/conversational-voice-design
 */
export const ELEVENLABS_RECOMMENDED_VOICES = {
  alexandra: "kdmDKE6EkgrWrrykO9Qt",
  archer: "L0Dsvb3SLTyegXwtm47J",
  jessica_anne_bogart: "g6xIsTj2HwM6VR4iXFCw",
  hope: "OYTbf65OHHFELVut7v2H",
  eryn: "dj3G1R1ilKoFKhBnWOzG",
  stuart: "HDA9tsk27wYi3uq0fPcK",
  mark: "1SM7GgM6IMuvQlz2BwM3",
  angela: "PT4nqlKZfc06VW1BuClj",
  finn: "vBKc2FfBKJfcZNyEt1n6",
  cassidy: "56AoDkrOh6qfVPDXZ7Pt",
  grandpa_spuds_oxley: "NOpBlnGInO9m6vDvFkFC",
} as const;

export const TASK_DEFAULTS = {
  ttsModel: "eleven_multilingual_v2",
  ttsVoice: ELEVENLABS_RECOMMENDED_VOICES.alexandra,
  ttsFormat: "mp3_44100_128" as ElevenLabsOutputFormat,
  sttModel: "scribe_v1",
  voiceChangerModel: "eleven_multilingual_sts_v2",
  sfxFormat: "mp3_44100_128" as ElevenLabsOutputFormat,
  musicFormat: "mp3_44100_128" as ElevenLabsOutputFormat,
};

/** File extension implied by an output_format string. */
export function extFromFormat(fmt: string): "mp3" | "wav" | "pcm" | "ulaw" | "alaw" | "opus" {
  if (fmt.startsWith("mp3")) return "mp3";
  if (fmt.startsWith("wav")) return "wav";
  if (fmt.startsWith("pcm")) return "pcm";
  if (fmt.startsWith("ulaw")) return "ulaw";
  if (fmt.startsWith("alaw")) return "alaw";
  if (fmt.startsWith("opus")) return "opus";
  return "mp3";
}
