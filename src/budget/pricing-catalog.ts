/**
 * Versioned price list (`multix.pricing/v1`, runtime-neutral). Each entry maps
 * a provider's models to USD per unit for one billing tier, with dated price
 * windows (scheduled changes and promotions end on a known instant), the date
 * the price was last checked against the provider's own pricing page, and that
 * page's URL. A model without a verified, current, fresh entry resolves to
 * "unknown": callers must not invent a price or fall back to $0.
 *
 * Audio is not billed by one formula: Gemini TTS bills text tokens in and audio
 * tokens out (25 tokens per second), ElevenLabs bills characters, Fish Audio
 * bills UTF-8 bytes. The meter names keep those units apart.
 *
 * OpenRouter speech and transcription prices are copied from its public models
 * catalog, whose `pricing` takes three shapes: `prompt` only = USD per input
 * character (speech) or per second of input audio (transcription),
 * `completion` only = USD per second of output audio, both = USD per input and
 * output token. That list shows each model's cheapest endpoint, and OpenRouter
 * may route a request to (or fall back on) any of them, so each entry holds the
 * highest price among the model's endpoints (`/models/<id>/endpoints`).
 * Token-priced transcription models (audio tokens per second not
 * published) and prices whose unit is unclear are left out, so they stay
 * "unknown".
 */

export const PRICING_SCHEMA = "multix.pricing/v1";

/** What a price is charged on. */
export type PriceMeter =
  /** Text tokens sent to the model. */
  | "input_text_tokens"
  /** Audio tokens the model returns (Gemini: 25 per second of audio). */
  | "output_audio_tokens"
  /** Characters of the text to speak (Unicode code points as sent). */
  | "characters"
  /** UTF-8 bytes of the text to speak. */
  | "utf8_bytes"
  /** Seconds of audio sent to be transcribed. */
  | "input_audio_seconds"
  /** Seconds of audio the model returns. */
  | "output_audio_seconds"
  /** Successful requests, whatever they return (Fish voice design). */
  | "requests"
  /** Seconds of video the model returns. */
  | "output_video_seconds"
  /** Video tokens: output frame area x seconds x frame rate / 1024 (Seedance). */
  | "video_tokens"
  /** Images the model returns. */
  | "output_images";

export interface PriceComponent {
  meter: PriceMeter;
  /** USD for `per` units. */
  usd: number;
  per: number;
}

export interface PriceWindow {
  /** ISO instant the price starts (inclusive); open-ended when absent. */
  from?: string;
  /** ISO instant the price ends (exclusive); open-ended when absent. */
  until?: string;
  /** "promotion", "scheduled", ...; shown with the estimate. */
  label?: string;
  components: PriceComponent[];
}

export interface PriceEntry {
  /** Stable id: "<provider>/<model family>@<tier>". */
  id: string;
  /** CLI group the price applies to (gemini, elevenlabs) or the provider name. */
  provider: string;
  models: string[];
  /** Billing tier the price is for; free tiers and plan credits are not modelled. */
  tier: string;
  currency: "USD";
  region: string;
  windows: PriceWindow[];
  /** Date (YYYY-MM-DD) the price was read from `source`. */
  last_checked: string;
  source: string;
  /** False keeps the entry for reference but never prices a run. */
  verified: boolean;
  notes?: string;
}

/** A price older than this is not trusted: re-check the source and bump last_checked. */
export const MAX_PRICE_AGE_DAYS = 120;

/** Prices near a window boundary may follow either window (time zones, rollout). */
const BOUNDARY_MS = 24 * 3600 * 1000;

const GEMINI_PRICING = "https://ai.google.dev/gemini-api/docs/pricing";
const ELEVENLABS_PRICING = "https://elevenlabs.io/pricing/api";
const FISH_PRICING =
  "https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits";

const OPENROUTER_SPEECH = "https://openrouter.ai/api/v1/models?output_modalities=speech";
const OPENROUTER_TRANSCRIPTION =
  "https://openrouter.ai/api/v1/models?output_modalities=transcription";
/** Gemini 3.8 TTS prices double on this date; re-check OpenRouter's price then. */
const GEMINI_38_PRICE_CHANGE = "2027-01-01T00:00:00Z";
/** Fish Audio's Drama 3 promotion ends; re-check OpenRouter's price then. */
const DRAMA_3_PROMOTION_END = "2026-11-12T17:00:00Z";

const perM = (meter: PriceMeter, usd: number): PriceComponent => ({ meter, usd, per: 1_000_000 });
const perK = (meter: PriceMeter, usd: number): PriceComponent => ({ meter, usd, per: 1_000 });

function geminiTts(input: number, output: number): PriceComponent[] {
  return [perM("input_text_tokens", input), perM("output_audio_tokens", output)];
}

/** One OpenRouter price, keyed by model id and canonical slug as the catalog lists them. */
function openrouter(
  id: string,
  models: string[],
  components: PriceComponent[],
  opts: { source: string; until?: string; label?: string; notes?: string },
): PriceEntry {
  return {
    id: `openrouter/${id}@api`,
    provider: "openrouter",
    models,
    tier: "api-usage",
    currency: "USD",
    region: "global",
    // A known end without a known next price: no window after it, so "unknown".
    windows: [
      {
        ...(opts.until ? { until: opts.until, label: opts.label ?? "scheduled" } : {}),
        components,
      },
    ],
    last_checked: "2026-10-26",
    source: opts.source,
    verified: true,
    notes:
      opts.notes ??
      "Highest price among the model's endpoints (/api/v1/models/<id>/endpoints); re-check against those, not only the models list.",
  };
}

const speechChars = (id: string, models: string[], usdPerM: number) =>
  openrouter(id, models, [perM("characters", usdPerM)], { source: OPENROUTER_SPEECH });
const sttSeconds = (id: string, models: string[], usdPerM: number) =>
  openrouter(id, models, [perM("input_audio_seconds", usdPerM)], {
    source: OPENROUTER_TRANSCRIPTION,
  });

const OPENROUTER_CATALOG: PriceEntry[] = [
  // Text to speech, USD per input character.
  speechChars(
    "elevenlabs-multilingual",
    [
      "elevenlabs/eleven-v4",
      "elevenlabs/eleven-v4-20260930",
      "elevenlabs/eleven-v3",
      "elevenlabs/eleven-v3-20260930",
      "elevenlabs/eleven-multilingual-v2",
      "elevenlabs/eleven-multilingual-v2-20260930",
    ],
    80,
  ),
  speechChars(
    "elevenlabs-flash-turbo",
    [
      "elevenlabs/eleven-v4-turbo",
      "elevenlabs/eleven-v4-turbo-20260930",
      "elevenlabs/eleven-v3-conversational",
      "elevenlabs/eleven-v3-conversational-20260930",
      "elevenlabs/eleven-flash-v2.5",
      "elevenlabs/eleven-flash-v2.5-20260930",
      "elevenlabs/eleven-flash-v2",
      "elevenlabs/eleven-flash-v2-20260930",
      "elevenlabs/eleven-turbo-v2.5",
      "elevenlabs/eleven-turbo-v2.5-20260930",
      "elevenlabs/eleven-turbo-v2",
      "elevenlabs/eleven-turbo-v2-20260930",
    ],
    40,
  ),
  speechChars(
    "minimax-speech-hd",
    ["minimax/speech-2.8-hd", "minimax/speech-2.8-hd-20260716"],
    100,
  ),
  speechChars(
    "minimax-speech-turbo",
    ["minimax/speech-2.8-turbo", "minimax/speech-2.8-turbo-20260716"],
    60,
  ),
  speechChars("deepgram-flux-tts", ["deepgram/flux-tts", "deepgram/flux-tts-20260812"], 45),
  speechChars("deepgram-aura-2", ["deepgram/aura-2", "deepgram/aura-2-20260716"], 30),
  speechChars(
    "microsoft-mai-voice",
    ["microsoft/mai-voice-2.1", "microsoft/mai-voice-2.1-20261001", "microsoft/mai-voice-2"],
    22,
  ),
  speechChars(
    "qwen-tts-plus",
    ["qwen/qwen-audio-3.0-tts-plus", "qwen/qwen-audio-3.0-tts-plus-20260723"],
    20,
  ),
  speechChars("voxtral-mini-tts-2603", ["mistralai/voxtral-mini-tts-2603"], 17.6),
  speechChars(
    "speech-15",
    [
      "heygen/heygen-voice-1",
      "heygen/heygen-voice-1-20261009",
      "microsoft/mai-voice-2.1-flash",
      "microsoft/mai-voice-2.1-flash-20261001",
      "microsoft/mai-voice-2-flash",
      "microsoft/mai-voice-2-flash-20260723",
      "qwen/qwen-audio-3.0-tts-flash",
      "qwen/qwen-audio-3.0-tts-flash-20260723",
      "x-ai/grok-voice-tts-1.0",
    ],
    15,
  ),
  speechChars(
    "voxtral-mini-tts",
    ["mistralai/voxtral-mini-tts-3-0", "mistralai/voxtral-mini-tts-3-0-20261020"],
    14.3,
  ),
  speechChars("orpheus", ["canopylabs/orpheus-3b-0.1-ft"], 15),
  speechChars("sesame-csm", ["sesame/csm-1b"], 7),
  speechChars(
    "heygen-voice-turbo",
    ["heygen/heygen-voice-1-turbo", "heygen/heygen-voice-1-turbo-20261009"],
    4,
  ),
  speechChars("kokoro", ["hexgrad/kokoro-82m"], 4),
  // Fish Audio bills UTF-8 bytes on its own API; bytes are never fewer than
  // characters, so pricing bytes keeps the ceiling safe whichever OpenRouter counts.
  openrouter(
    "fish-s2",
    [
      "fish-audio/s2.1-pro",
      "fish-audio/s2.1-pro-20260729",
      "fish-audio/s2-pro",
      "fish-audio/s2-pro-20260729",
      "fish-audio/s1",
      "fish-audio/s1-20260729",
    ],
    [perM("utf8_bytes", 15)],
    { source: OPENROUTER_SPEECH },
  ),
  openrouter(
    "fish-drama-3",
    ["fish-audio/drama-3", "fish-audio/drama-3-20261013"],
    [perM("utf8_bytes", 2)],
    { source: OPENROUTER_SPEECH, until: DRAMA_3_PROMOTION_END, label: "promotion" },
  ),
  // Gemini TTS through OpenRouter: tokens in, audio tokens out (25 per second).
  openrouter(
    "gemini-3.8-flash-tts",
    ["google/gemini-3.8-flash-tts", "google/gemini-3.8-flash-tts-20260922"],
    geminiTts(0.5, 9),
    { source: OPENROUTER_SPEECH, until: GEMINI_38_PRICE_CHANGE },
  ),
  openrouter(
    "gemini-3.8-flash-lite-tts",
    ["google/gemini-3.8-flash-lite-tts", "google/gemini-3.8-flash-lite-tts-20260922"],
    geminiTts(0.5, 6),
    { source: OPENROUTER_SPEECH, until: GEMINI_38_PRICE_CHANGE },
  ),
  openrouter(
    "gemini-3.1-flash-tts-preview",
    ["google/gemini-3.1-flash-tts-preview"],
    geminiTts(1, 20),
    { source: OPENROUTER_SPEECH },
  ),
  // Seed Audio bills seconds of audio it returns, so its ceiling is an estimate.
  openrouter(
    "seed-audio",
    ["bytedance-seed/seed-audio-1-0", "bytedance-seed/seed-audio-1-0-20260630"],
    [perK("output_audio_seconds", 2.5)],
    { source: OPENROUTER_SPEECH },
  ),
  // Speech to text, USD per second of input audio.
  sttSeconds("google-chirp-3", ["google/chirp-3"], 266.666666667),
  sttSeconds(
    "stt-100",
    [
      "openai/whisper-1",
      "fish-audio/transcribe-1-pro",
      "fish-audio/transcribe-1-pro-20260924",
      "fish-audio/transcribe-1",
      "fish-audio/transcribe-1-20260729",
    ],
    100,
  ),
  sttSeconds(
    "assemblyai-universal",
    [
      "assemblyai/universal-3-6-pro",
      "assemblyai/universal-3-6-pro-20261014",
      "assemblyai/universal-3-5-pro",
      "assemblyai/universal-3-5-pro-20260914",
    ],
    83.3333,
  ),
  sttSeconds(
    "openai-gpt-transcribe",
    ["openai/gpt-transcribe", "openai/gpt-transcribe-20260805"],
    75,
  ),
  sttSeconds("deepgram-nova-3", ["deepgram/nova-3", "deepgram/nova-3-20260714"], 71.6666666667),
  sttSeconds(
    "voxtral-small-transcribe",
    ["mistralai/voxtral-small-transcribe-3-0", "mistralai/voxtral-small-transcribe-3-0-20261020"],
    73.3333,
  ),
  sttSeconds(
    "elevenlabs-scribe-v2",
    [
      "elevenlabs/scribe-v2",
      "elevenlabs/scribe-v2-20260929",
      "elevenlabs/scribe-v2-medical",
      "elevenlabs/scribe-v2-medical-20260929",
    ],
    61.1111111111,
  ),
  sttSeconds(
    "voxtral-mini-transcribe-3",
    ["mistralai/voxtral-mini-transcribe-3-0", "mistralai/voxtral-mini-transcribe-3-0-20261020"],
    64.1667,
  ),
  sttSeconds(
    "voxtral-mini-transcribe",
    ["mistralai/voxtral-mini-transcribe", "mistralai/voxtral-mini-transcribe-2602"],
    55,
  ),
  sttSeconds(
    "stt-50",
    [
      "meta/muse-voice-transcribe-1.0",
      "meta/muse-voice-transcribe-1.0-20260903",
      "mistralai/voxtral-small-24b-2507-stt",
      "mistralai/voxtral-small-24b-2507-stt-20260813",
    ],
    50,
  ),
  sttSeconds("x-ai-grok-stt", ["x-ai/grok-stt-1.0", "x-ai/grok-stt-20260723"], 27.7777777778),
  sttSeconds("nvidia-parakeet", ["nvidia/parakeet-tdt-0.6b-v3"], 25),
  sttSeconds(
    "voxtral-mini-3b",
    ["mistralai/voxtral-mini-3b-2507", "mistralai/voxtral-mini-3b-2507-20260813"],
    16.6667,
  ),
  sttSeconds("whisper-large-v3", ["openai/whisper-large-v3"], 30.8333333333),
  sttSeconds("whisper-large-v3-turbo", ["openai/whisper-large-v3-turbo"], 11.1111111111),
  sttSeconds("qwen3-asr-1.7b", ["qwen/qwen3-asr-1.7b", "qwen/qwen3-asr-1.7b-20260813"], 7.5),
  sttSeconds(
    "stt-3.33",
    [
      "qwen/qwen3-asr-0.6b",
      "qwen/qwen3-asr-0.6b-20260813",
      "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b",
      "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b-20260813",
    ],
    3.33,
  ),
];

export const PRICING_CATALOG: PriceEntry[] = [
  {
    id: "gemini/gemini-3.8-flash-tts@paid-standard",
    provider: "gemini",
    models: ["gemini-3.8-flash-tts"],
    tier: "paid-standard",
    currency: "USD",
    region: "global",
    windows: [
      { until: "2027-01-01T00:00:00Z", label: "scheduled", components: geminiTts(0.5, 9) },
      { from: "2027-01-01T00:00:00Z", components: geminiTts(1, 18) },
    ],
    last_checked: "2026-10-26",
    source: GEMINI_PRICING,
    verified: true,
    notes: "Free tier is free of charge; this is the paid Standard tier (upper bound).",
  },
  {
    id: "gemini/gemini-3.8-flash-lite-tts@paid-standard",
    provider: "gemini",
    models: ["gemini-3.8-flash-lite-tts"],
    tier: "paid-standard",
    currency: "USD",
    region: "global",
    windows: [
      { until: "2027-01-01T00:00:00Z", label: "scheduled", components: geminiTts(0.5, 6) },
      { from: "2027-01-01T00:00:00Z", components: geminiTts(1, 12) },
    ],
    last_checked: "2026-10-26",
    source: GEMINI_PRICING,
    verified: true,
    notes: "Free tier is free of charge; this is the paid Standard tier (upper bound).",
  },
  {
    id: "gemini/gemini-3.1-flash-tts-preview@paid-standard",
    provider: "gemini",
    models: ["gemini-3.1-flash-tts-preview"],
    tier: "paid-standard",
    currency: "USD",
    region: "global",
    windows: [{ components: geminiTts(1, 20) }],
    last_checked: "2026-10-26",
    source: GEMINI_PRICING,
    verified: true,
  },
  {
    id: "gemini/gemini-2.5-flash-preview-tts@paid-standard",
    provider: "gemini",
    models: ["gemini-2.5-flash-preview-tts"],
    tier: "paid-standard",
    currency: "USD",
    region: "global",
    windows: [{ components: geminiTts(0.5, 10) }],
    last_checked: "2026-10-26",
    source: GEMINI_PRICING,
    verified: true,
  },
  {
    id: "gemini/gemini-2.5-pro-preview-tts@paid-standard",
    provider: "gemini",
    models: ["gemini-2.5-pro-preview-tts"],
    tier: "paid-standard",
    currency: "USD",
    region: "global",
    windows: [{ components: geminiTts(1, 20) }],
    last_checked: "2026-10-26",
    source: GEMINI_PRICING,
    verified: true,
  },
  {
    id: "elevenlabs/multilingual@api",
    provider: "elevenlabs",
    models: ["eleven_v4", "eleven_v3", "eleven_multilingual_v2"],
    tier: "api-usage",
    currency: "USD",
    region: "global",
    windows: [{ components: [perK("characters", 0.08)] }],
    last_checked: "2026-10-26",
    source: ELEVENLABS_PRICING,
    verified: true,
    notes: "API usage billed in USD per character; subscription plans spend credits instead.",
  },
  {
    id: "elevenlabs/flash-turbo@api",
    provider: "elevenlabs",
    models: [
      "eleven_v4_turbo",
      "eleven_flash_v2_5",
      "eleven_flash_v2",
      "eleven_turbo_v2_5",
      "eleven_turbo_v2",
    ],
    tier: "api-usage",
    currency: "USD",
    region: "global",
    windows: [{ components: [perK("characters", 0.04)] }],
    last_checked: "2026-10-26",
    source: ELEVENLABS_PRICING,
    verified: true,
    notes: "API usage billed in USD per character; subscription plans spend credits instead.",
  },
  {
    id: "fish/s2-pro@api",
    provider: "fish",
    models: ["s2.1-pro", "s2-pro"],
    tier: "api-usage",
    currency: "USD",
    region: "global",
    windows: [{ components: [perM("utf8_bytes", 15)] }],
    last_checked: "2026-10-26",
    source: FISH_PRICING,
    verified: true,
  },
  {
    id: "gemini/lyria-3-clip@paid-standard",
    provider: "gemini",
    models: ["lyria-3-clip-preview"],
    tier: "paid-standard",
    currency: "USD",
    region: "global",
    windows: [{ components: [{ meter: "requests", usd: 0.04, per: 1 }] }],
    last_checked: "2026-10-31",
    source: GEMINI_PRICING,
    verified: true,
    notes: "Per 30-second clip; no free tier.",
  },
  {
    id: "gemini/lyria-3.5@paid-standard",
    provider: "gemini",
    models: ["lyria-3.5"],
    tier: "paid-standard",
    currency: "USD",
    region: "global",
    windows: [{ components: [{ meter: "requests", usd: 0.08, per: 1 }] }],
    last_checked: "2026-10-31",
    source: GEMINI_PRICING,
    verified: true,
    notes: "Per full song, whatever its length; no free tier.",
  },
  {
    id: "fish/voice-design-1@api",
    provider: "fish",
    models: ["voice-design-1"],
    tier: "api-usage",
    currency: "USD",
    region: "global",
    windows: [{ components: [{ meter: "requests", usd: 0.01, per: 1 }] }],
    last_checked: "2026-10-27",
    source: FISH_PRICING,
    verified: true,
    notes: "Billed once per successful POST /v1/voice-design, however many candidates it returns.",
  },
  {
    id: "fish/s2.1-pro-free@api",
    provider: "fish",
    models: ["s2.1-pro-free"],
    tier: "api-usage",
    currency: "USD",
    region: "global",
    // Listed at $0 on the pricing page; the free model's limits are not modelled.
    windows: [{ components: [perM("utf8_bytes", 0)] }],
    last_checked: "2026-10-27",
    source: FISH_PRICING,
    verified: true,
  },
  {
    id: "fish/s1@api",
    provider: "fish",
    models: ["s1"],
    tier: "api-usage",
    currency: "USD",
    region: "global",
    // Retired after 2026; requests are then served (and billed) as s2.1-pro.
    windows: [{ components: [perM("utf8_bytes", 15)] }],
    last_checked: "2026-10-26",
    source: FISH_PRICING,
    verified: true,
  },
  {
    id: "fish/drama-3@api",
    provider: "fish",
    models: ["drama-3"],
    tier: "api-usage",
    currency: "USD",
    region: "global",
    windows: [
      {
        until: "2026-11-12T17:00:00Z",
        label: "promotion",
        components: [perM("utf8_bytes", 10)],
      },
      { from: "2026-11-12T17:00:00Z", components: [perM("utf8_bytes", 50)] },
    ],
    last_checked: "2026-10-26",
    source: FISH_PRICING,
    verified: true,
  },
  ...OPENROUTER_CATALOG,
];

export interface ResolvedRate {
  id: string;
  provider: string;
  model: string;
  tier: string;
  currency: "USD";
  region: string;
  /** Price in force at the requested instant. */
  components: PriceComponent[];
  /** Highest price per meter among windows within a day of the instant. */
  upper_components: PriceComponent[];
  label?: string;
  effective_from?: string;
  effective_until?: string;
  last_checked: string;
  source: string;
  notes?: string;
}

export type RateLookup =
  | { ok: true; rate: ResolvedRate }
  | { ok: false; reason: "no_price" | "unverified" | "stale" | "no_window"; detail: string };

function inWindow(w: PriceWindow, t: number): boolean {
  return (
    (w.from === undefined || Date.parse(w.from) <= t) &&
    (w.until === undefined || t < Date.parse(w.until))
  );
}

function nearWindow(w: PriceWindow, t: number): boolean {
  return (
    (w.from === undefined || Date.parse(w.from) <= t + BOUNDARY_MS) &&
    (w.until === undefined || t - BOUNDARY_MS < Date.parse(w.until))
  );
}

function maxComponents(windows: PriceWindow[]): PriceComponent[] {
  const byMeter = new Map<PriceMeter, PriceComponent>();
  for (const w of windows) {
    for (const c of w.components) {
      const prev = byMeter.get(c.meter);
      if (!prev || c.usd / c.per > prev.usd / prev.per) byMeter.set(c.meter, c);
    }
  }
  return [...byMeter.values()];
}

/** The trusted price for one provider model at `at`, or why there is none. */
export function resolveRate(
  provider: string,
  model: string,
  at: Date = new Date(),
  catalog: PriceEntry[] = PRICING_CATALOG,
): RateLookup {
  const entry = catalog.find((e) => e.provider === provider && e.models.includes(model));
  if (!entry) {
    return { ok: false, reason: "no_price", detail: `No price on file for ${provider} ${model}` };
  }
  if (!entry.verified) {
    return { ok: false, reason: "unverified", detail: `Price ${entry.id} is not verified` };
  }
  const t = at.getTime();
  const ageDays = (t - Date.parse(`${entry.last_checked}T00:00:00Z`)) / 86_400_000;
  if (!(ageDays <= MAX_PRICE_AGE_DAYS)) {
    return {
      ok: false,
      reason: "stale",
      detail: `Price ${entry.id} was last checked ${entry.last_checked}, over ${MAX_PRICE_AGE_DAYS} days ago`,
    };
  }
  const current = entry.windows.find((w) => inWindow(w, t));
  if (!current) {
    return {
      ok: false,
      reason: "no_window",
      detail: `Price ${entry.id} has no window covering ${at.toISOString()}`,
    };
  }
  // A price that ends within a day with no known successor may already have
  // changed (time zones, rollout): there is no higher price to bound it with.
  const end = current.until === undefined ? undefined : Date.parse(current.until);
  if (end !== undefined && end - t < BOUNDARY_MS && !entry.windows.some((w) => inWindow(w, end))) {
    return {
      ok: false,
      reason: "no_window",
      detail: `Price ${entry.id} ends ${current.until} and the next price is not known`,
    };
  }
  return {
    ok: true,
    rate: {
      id: entry.id,
      provider: entry.provider,
      model,
      tier: entry.tier,
      currency: entry.currency,
      region: entry.region,
      components: current.components,
      upper_components: maxComponents(entry.windows.filter((w) => nearWindow(w, t))),
      ...(current.label ? { label: current.label } : {}),
      ...(current.from ? { effective_from: current.from } : {}),
      ...(current.until ? { effective_until: current.until } : {}),
      last_checked: entry.last_checked,
      source: entry.source,
      ...(entry.notes ? { notes: entry.notes } : {}),
    },
  };
}

/** USD for `units` of `meter` under `components`; undefined when the meter has no price. */
export function priceOf(
  components: PriceComponent[],
  meter: PriceMeter,
  units: number,
): number | undefined {
  const c = components.find((x) => x.meter === meter);
  return c ? (units * c.usd) / c.per : undefined;
}
