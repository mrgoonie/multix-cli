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

/** What a TTS model accepts, so the CLI can reject or drop what it would ignore. */
export interface TtsModelCaps {
  /** Longest `text` one request takes. */
  maxChars: number;
  /** Honours voice_settings.style (`can_use_style`). */
  style: boolean;
  /** Honours voice_settings.use_speaker_boost (`can_use_speaker_boost`). */
  speakerBoost: boolean;
  /** Accepts previous_text / next_text. */
  contextText: boolean;
  /** Performs inline audio tags such as [whispering] instead of reading them aloud. */
  audioTags: boolean;
  /** Accepts voice_settings.clone_strength (others answer 400 unsupported_model). */
  cloneStrength: boolean;
  /** Pauses for SSML <break time="..."/> (others skip the tag without a pause). */
  ssmlBreak: boolean;
  /** Speaks SSML <phoneme> pronunciations (others drop the tagged word entirely). */
  ssmlPhoneme: boolean;
}

/**
 * Per-model TTS capabilities, from GET /v1/models (can_use_style,
 * can_use_speaker_boost, maximum_text_length_per_request) and the API's own
 * answers, checked on 2026-10-26: eleven_v3 rejects previous_text/next_text
 * with 400 unsupported_model; v4 accepts them. v4 and v4 Turbo accept style
 * and speaker boost without error but ignore them ("Style and Speed sliders
 * are not available in Eleven v4"). Language support is left to the API,
 * which answers an unsupported language_code with 400 unsupported_language
 * and accepts a supported one. clone_strength (0..1) is accepted by v4 and
 * v4 Turbo only; every other model answers 400 unsupported_model. SSML, from
 * the duration and transcript of the generated audio: v4, v4 Turbo, v3 and
 * v3 conversational skip <break> with no pause; multilingual v2 and
 * Flash/Turbo v2.5 drop a word wrapped in <phoneme> instead of speaking it.
 */
export const ELEVENLABS_TTS_MODEL_CAPS: Record<ElevenLabsTtsModel, TtsModelCaps> = {
  eleven_v4: {
    maxChars: 10_000,
    style: false,
    speakerBoost: false,
    contextText: true,
    audioTags: true,
    cloneStrength: true,
    ssmlBreak: false,
    ssmlPhoneme: true,
  },
  eleven_v4_turbo: {
    maxChars: 10_000,
    style: false,
    speakerBoost: false,
    contextText: true,
    audioTags: true,
    cloneStrength: true,
    ssmlBreak: false,
    ssmlPhoneme: true,
  },
  eleven_v3: {
    maxChars: 5_000,
    style: false,
    speakerBoost: false,
    contextText: false,
    audioTags: true,
    cloneStrength: false,
    ssmlBreak: false,
    ssmlPhoneme: true,
  },
  eleven_v3_conversational: {
    maxChars: 5_000,
    style: false,
    speakerBoost: true,
    contextText: false,
    audioTags: true,
    cloneStrength: false,
    ssmlBreak: false,
    ssmlPhoneme: true,
  },
  eleven_multilingual_v2: {
    maxChars: 10_000,
    style: true,
    speakerBoost: true,
    contextText: true,
    audioTags: false,
    cloneStrength: false,
    ssmlBreak: true,
    ssmlPhoneme: false,
  },
  eleven_flash_v2_5: {
    maxChars: 40_000,
    style: false,
    speakerBoost: false,
    contextText: true,
    audioTags: false,
    cloneStrength: false,
    ssmlBreak: true,
    ssmlPhoneme: false,
  },
  eleven_flash_v2: {
    maxChars: 30_000,
    style: false,
    speakerBoost: false,
    contextText: true,
    audioTags: false,
    cloneStrength: false,
    ssmlBreak: true,
    ssmlPhoneme: true,
  },
  eleven_turbo_v2_5: {
    maxChars: 40_000,
    style: false,
    speakerBoost: false,
    contextText: true,
    audioTags: false,
    cloneStrength: false,
    ssmlBreak: true,
    ssmlPhoneme: false,
  },
  eleven_turbo_v2: {
    maxChars: 30_000,
    style: false,
    speakerBoost: false,
    contextText: true,
    audioTags: false,
    cloneStrength: false,
    ssmlBreak: true,
    ssmlPhoneme: true,
  },
};

export function ttsModelCaps(model: string): TtsModelCaps | undefined {
  return Object.hasOwn(ELEVENLABS_TTS_MODEL_CAPS, model)
    ? ELEVENLABS_TTS_MODEL_CAPS[model as ElevenLabsTtsModel]
    : undefined;
}

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

/**
 * Full output_format enum of /text-to-speech (API reference, 2026-10-26).
 * mp3_44100_192 needs Creator tier; 44.1 kHz PCM/WAV need Pro tier.
 */
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

export type ElevenLabsOutputFormat = (typeof ELEVENLABS_OUTPUT_FORMATS)[number];

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
  if (fmt.startsWith("opus")) return "opus";
  if (fmt.startsWith("pcm")) return "pcm";
  if (fmt.startsWith("ulaw")) return "ulaw";
  if (fmt.startsWith("alaw")) return "alaw";
  return "mp3";
}
