/**
 * ElevenLabs constants — model IDs, output formats, defaults.
 */

export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";

export const ELEVENLABS_TTS_MODELS = [
  "eleven_v4",
  "eleven_v4_turbo",
  "eleven_v3",
  "eleven_multilingual_v2",
  "eleven_flash_v2_5",
  "eleven_flash_v2",
  "eleven_turbo_v2_5",
  "eleven_turbo_v2",
] as const;

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

/** Output formats /text-to-speech accepts (the shared list plus the newer codecs). */
export const ELEVENLABS_TTS_OUTPUT_FORMATS = [
  ...ELEVENLABS_OUTPUT_FORMATS,
  "mp3_24000_48",
  "pcm_32000",
  "pcm_48000",
  "alaw_8000",
  "opus_48000_32",
  "opus_48000_64",
  "opus_48000_96",
  "opus_48000_128",
  "opus_48000_192",
  "wav_8000",
  "wav_16000",
  "wav_22050",
  "wav_24000",
  "wav_32000",
  "wav_44100",
  "wav_48000",
] as const;

/** Keys of the `voice_settings` object of a TTS request. */
export type VoiceSettingKey =
  | "stability"
  | "similarity_boost"
  | "style"
  | "use_speaker_boost"
  | "clone_strength";

/**
 * What each TTS model accepts, from GET /v1/models (`can_use_style`,
 * `can_use_speaker_boost`, `maximum_text_length_per_request`) and the model docs.
 * https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4
 */
export interface TtsModelCapabilities {
  /** Longest `text` one request may carry. */
  maxChars: number;
  /** Voice settings the model uses; the API accepts others and ignores them. */
  voiceSettings: readonly VoiceSettingKey[];
  /** `language_code` is honoured (multilingual_v2 ignores it). */
  languageCode: boolean;
  /** `previous_text` / `next_text` are accepted (eleven_v3 rejects them with 400). */
  contextText: boolean;
  /** Bracketed audio tags such as `[whispers]` direct delivery instead of being read aloud. */
  audioTags: boolean;
  /** SSML `<break>` / `<phoneme>` tags are interpreted. */
  ssml: boolean;
  /**
   * An option the model does not use is an error, not a warning. Set for models
   * added after the generic voice settings were always sent, so no existing
   * invocation depends on them being accepted.
   */
  strict: boolean;
}

const V4: TtsModelCapabilities = {
  maxChars: 10_000,
  voiceSettings: ["stability", "similarity_boost", "clone_strength"],
  languageCode: true,
  contextText: true,
  audioTags: true,
  ssml: false,
  strict: true,
};

const FLASH_TURBO = (maxChars: number, languageCode: boolean): TtsModelCapabilities => ({
  maxChars,
  voiceSettings: ["stability", "similarity_boost"],
  languageCode,
  contextText: true,
  audioTags: false,
  ssml: true,
  strict: false,
});

export const TTS_MODEL_CAPABILITIES: Readonly<
  Record<(typeof ELEVENLABS_TTS_MODELS)[number], TtsModelCapabilities>
> = {
  eleven_v4: V4,
  eleven_v4_turbo: V4,
  eleven_v3: {
    maxChars: 5_000,
    voiceSettings: ["stability", "similarity_boost"],
    languageCode: true,
    contextText: false,
    audioTags: true,
    ssml: false,
    strict: false,
  },
  eleven_multilingual_v2: {
    maxChars: 10_000,
    voiceSettings: ["stability", "similarity_boost", "style", "use_speaker_boost"],
    languageCode: false,
    contextText: true,
    audioTags: false,
    ssml: true,
    strict: false,
  },
  eleven_flash_v2_5: FLASH_TURBO(40_000, true),
  eleven_turbo_v2_5: FLASH_TURBO(40_000, true),
  eleven_flash_v2: FLASH_TURBO(30_000, false),
  eleven_turbo_v2: FLASH_TURBO(30_000, false),
};

/** Capabilities of a known TTS model; undefined for ids this CLI has not verified. */
export function ttsModelCapabilities(model: string): TtsModelCapabilities | undefined {
  return Object.hasOwn(TTS_MODEL_CAPABILITIES, model)
    ? TTS_MODEL_CAPABILITIES[model as keyof typeof TTS_MODEL_CAPABILITIES]
    : undefined;
}

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
  if (fmt.startsWith("pcm")) return "pcm";
  if (fmt.startsWith("ulaw")) return "ulaw";
  if (fmt.startsWith("alaw")) return "alaw";
  if (fmt.startsWith("opus")) return "opus";
  if (fmt.startsWith("wav")) return "wav";
  return "mp3";
}
