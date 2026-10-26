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
  | "utf8_bytes";

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

const perM = (meter: PriceMeter, usd: number): PriceComponent => ({ meter, usd, per: 1_000_000 });
const perK = (meter: PriceMeter, usd: number): PriceComponent => ({ meter, usd, per: 1_000 });

function geminiTts(input: number, output: number): PriceComponent[] {
  return [perM("input_text_tokens", input), perM("output_audio_tokens", output)];
}

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
