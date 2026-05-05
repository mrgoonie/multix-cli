/**
 * ElevenLabs constants — model IDs, output formats, defaults.
 */

export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";

export const ELEVENLABS_TTS_MODELS = [
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
export function extFromFormat(fmt: string): "mp3" | "wav" | "pcm" | "ulaw" {
  if (fmt.startsWith("mp3")) return "mp3";
  if (fmt.startsWith("pcm")) return "pcm";
  if (fmt.startsWith("ulaw")) return "ulaw";
  return "mp3";
}
