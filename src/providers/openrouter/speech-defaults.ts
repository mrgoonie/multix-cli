/**
 * Default OpenRouter speech models (runtime-neutral, no imports), shared by the
 * commands and the pre-flight cost estimator without pulling in the clients.
 */

/** Env that overrides the default speech model. */
export const OPENROUTER_TTS_MODEL_ENV = "OPENROUTER_TTS_MODEL";
export const DEFAULT_OPENROUTER_TTS_MODEL = "google/gemini-3.8-flash-tts";
/** Largest `speed` the OpenRouter speech endpoint takes (it must also be above 0). */
export const OPENROUTER_MAX_SPEED = 4;
export const DEFAULT_OPENROUTER_STT_MODEL = "openai/whisper-large-v3-turbo";
