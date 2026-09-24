/**
 * Gemini TTS voices and model registry.
 * Source: https://ai.google.dev/gemini-api/docs/speech-generation
 */

/** All 30 prebuilt Gemini TTS voices. */
export const GEMINI_TTS_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
] as const;

export type GeminiTtsVoice = (typeof GEMINI_TTS_VOICES)[number];

/** TTS-capable Gemini models. */
export const GEMINI_TTS_MODELS = new Set([
  "gemini-3.8-flash-lite-tts",
  "gemini-3.8-flash-tts",
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
]);

/**
 * Gemini 3.8 TTS models: served by the Interactions API, read text verbatim,
 * take delivery direction via speech_metadata style, and accept custom voice ids.
 */
export const GEMINI_INTERACTIONS_TTS_MODELS = new Set([
  "gemini-3.8-flash-lite-tts",
  "gemini-3.8-flash-tts",
]);

/** Default TTS model (Gemini 3.8 Flash-Lite TTS — Google's replacement for 3.1 Flash TTS). */
export const TTS_MODEL_DEFAULT = "gemini-3.8-flash-lite-tts";

/** Default voice when caller does not specify one. */
export const TTS_VOICE_DEFAULT: GeminiTtsVoice = "Kore";

/** Output PCM specs (fixed by API). */
export const TTS_PCM_SAMPLE_RATE = 24_000;
export const TTS_PCM_CHANNELS = 1;
export const TTS_PCM_BITS_PER_SAMPLE = 16;

/** Supported output container formats. */
export const TTS_OUTPUT_FORMATS = ["wav", "pcm"] as const;
export type TtsOutputFormat = (typeof TTS_OUTPUT_FORMATS)[number];

export function isValidGeminiVoice(name: string): name is GeminiTtsVoice {
  return (GEMINI_TTS_VOICES as readonly string[]).includes(name);
}

/** Designed/replicated voice ids (`voice_...` stateful, `voicekey_...` stateless) — Gemini 3.8 only. */
export function isCustomGeminiVoiceId(name: string): boolean {
  return /^(voice|voicekey)_[A-Za-z0-9_-]+$/.test(name);
}

/** Whether `voice` is usable with `model` (3.8 models also accept custom voice ids). */
export function isVoiceAllowedForModel(voice: string, model: string): boolean {
  return (
    isValidGeminiVoice(voice) ||
    (GEMINI_INTERACTIONS_TTS_MODELS.has(model) && isCustomGeminiVoiceId(voice))
  );
}
