/**
 * Fish Audio models and limits (runtime-neutral data).
 *
 * The TTS model is chosen by the `model` HTTP header, not the body. A request
 * whose header is missing or not an exact match is served and billed as
 * `s2.1-pro`, and the 200 audio response carries nothing that names the model
 * that ran, so multix sends only header values from this allowlist.
 * Docs: https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
 */

export const FISH_API_BASE = "https://api.fish.audio";
export const FISH_API_KEY_URL = "https://fish.audio/app/api-keys/";
export const FISH_TTS_SOURCE =
  "https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech";

/** `model` header values /v1/tts accepts (exact spelling). */
export const FISH_TTS_MODELS = ["drama-3", "s2.1-pro", "s2.1-pro-free", "s2-pro", "s1"] as const;
export type FishTtsModel = (typeof FISH_TTS_MODELS)[number];

export const DEFAULT_FISH_TTS_MODEL: FishTtsModel = "drama-3";
export const FISH_TTS_MODEL_ENV = "FISH_TTS_MODEL";

/** What Fish serves when the header is missing or misspelled. */
export const FISH_SERVER_DEFAULT_MODEL: FishTtsModel = "s2.1-pro";

/** Multi-speaker (`<|speaker:N|>` with a reference_id array) works on the S2 family and drama-3, not s1. */
export const FISH_MULTI_SPEAKER_MODELS: readonly FishTtsModel[] = [
  "drama-3",
  "s2.1-pro",
  "s2.1-pro-free",
  "s2-pro",
];

export const FISH_TTS_FORMATS = ["mp3", "wav", "pcm", "opus"] as const;
export type FishTtsFormat = (typeof FISH_TTS_FORMATS)[number];

/** WAV/PCM are 16-bit mono at 44.1 kHz unless `sample_rate` says otherwise; Opus is 48 kHz. */
export const FISH_DEFAULT_SAMPLE_RATE = 44_100;
/** Sample rates the TTS docs list per output format. */
export const FISH_SAMPLE_RATES: Readonly<Record<FishTtsFormat, readonly number[]>> = {
  wav: [8000, 16_000, 24_000, 32_000, 44_100],
  pcm: [8000, 16_000, 24_000, 32_000, 44_100],
  mp3: [32_000, 44_100],
  opus: [48_000],
};

/** The rate Fish produces for `format` when `requested` is unset. */
export function fishSampleRate(format: FishTtsFormat, requested?: number): number {
  return requested ?? (format === "opus" ? 48_000 : FISH_DEFAULT_SAMPLE_RATE);
}
export const FISH_MP3_BITRATES = [64, 128, 192] as const;
export const FISH_LATENCIES = ["low", "normal", "balanced"] as const;

/** Public voices from the Fish Audio docs, for examples and the façade default. */
export const FISH_PUBLIC_VOICES: Readonly<Record<string, string>> = {
  adrian: "bf322df2096a46f18c579d0baa36f41d",
  delia: "c70cfb98867a4bfb9ae20d2401257b92",
  sheila: "f3a2b90078d54a65af4b95f63bc7798e",
};

/** Upper bound multix accepts per request; Fish chunks long text itself. */
export const FISH_MAX_TEXT_BYTES = 200_000;
/** Speakers multix maps into one request. */
export const FISH_MAX_SPEAKERS = 10;

export function isFishTtsModel(value: string): value is FishTtsModel {
  return (FISH_TTS_MODELS as readonly string[]).includes(value);
}

/** `model` header /v1/voice-design requires (exact spelling). */
export const FISH_VOICE_DESIGN_MODEL = "voice-design-1";
export const FISH_VOICE_DESIGN_SOURCE =
  "https://docs.fish.audio/api-reference/endpoint/openapi-v1/voice-design";
export const FISH_CREATE_MODEL_SOURCE =
  "https://docs.fish.audio/api-reference/endpoint/model/create-model";
