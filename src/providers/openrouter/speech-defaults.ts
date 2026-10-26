/**
 * Default OpenRouter speech models (runtime-neutral, no imports), shared by the
 * commands and the pre-flight cost estimator without pulling in the clients.
 */

export const DEFAULT_OPENROUTER_TTS_MODEL = "google/gemini-3.8-flash-tts";
export const DEFAULT_OPENROUTER_STT_MODEL = "openai/whisper-large-v3-turbo";
