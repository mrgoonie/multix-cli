/**
 * Pre-flight cost estimates (runtime-neutral, no network). Counts the units a
 * provider bills (characters, UTF-8 bytes, text tokens, audio seconds/tokens)
 * from the request itself (and, for transcription, the measured length of the
 * input audio) and prices them with the catalog. The result is a
 * range with its provenance; `upper_bound` says whether the high end is a
 * proven ceiling (billed units are known up front) or only an estimate (the
 * provider bills output it has not produced yet, e.g. seconds of audio).
 */

import { type PriceMeter, type ResolvedRate, priceOf, resolveRate } from "./pricing-catalog.js";

export interface TextUnits {
  /** Unicode code points as sent (what "characters" means for billing). */
  characters: number;
  /** Code points after NFC: Vietnamese typed as NFD has more code points than NFC. */
  nfc_characters: number;
  utf8_bytes: number;
  /** UTF-16 code units: astral characters (emoji) count twice if a provider counts these. */
  utf16_units: number;
}

export interface UnitRange {
  low: number;
  expected: number;
  high: number;
}

export interface EstimateRequest {
  provider: string;
  model: string;
  /** Text that is billed (the words to speak). */
  text: string;
  /** Text sent alongside that may be billed (context, style); counted in the high end only. */
  extra_text?: string[];
  /** Length of the audio to transcribe, measured by the caller (seconds). */
  audio_seconds?: number;
  at?: Date;
}

export interface CostEstimate {
  status: "estimated" | "unknown";
  /** Why there is no price (no_price, unverified, stale, no_window, unsupported). */
  reason?: string;
  detail?: string;
  currency: "USD";
  provider: string;
  model: string;
  low_usd: number | null;
  expected_usd: number | null;
  high_usd: number | null;
  /** proven: billed units are known up front; estimated: high end is a guess; none: no price. */
  upper_bound: "proven" | "estimated" | "none";
  text: TextUnits;
  units: Partial<Record<PriceMeter, UnitRange>>;
  rate?: Pick<
    ResolvedRate,
    | "id"
    | "tier"
    | "components"
    | "label"
    | "effective_from"
    | "effective_until"
    | "last_checked"
    | "source"
    | "notes"
  >;
  assumptions: string[];
  /** When the estimate was made (prices are dated). */
  at: string;
}

/** Gemini returns 25 audio tokens per second of speech. */
export const GEMINI_AUDIO_TOKENS_PER_SECOND = 25;
/** Speech rate bounds in characters per second (fast read, typical, slow with pauses). */
const CHARS_PER_SECOND = { fast: 25, typical: 14, slow: 6 };
/**
 * Billed audio seconds may exceed the measured length: a container's header
 * can understate it, and providers may bill in increments of up to a minute.
 */
const AUDIO_LENGTH_MARGIN = 1.05;
const BILLING_INCREMENT_SECONDS = 60;
/** Tokens the request adds around the text (voice config, turn markers). */
const PROMPT_OVERHEAD_TOKENS = 64;

const encoder = new TextEncoder();

export function countText(text: string): TextUnits {
  return {
    characters: [...text].length,
    nfc_characters: [...text.normalize("NFC")].length,
    utf8_bytes: encoder.encode(text).length,
    utf16_units: text.length,
  };
}

function addUnits(a: TextUnits, b: TextUnits): TextUnits {
  return {
    characters: a.characters + b.characters,
    nfc_characters: a.nfc_characters + b.nfc_characters,
    utf8_bytes: a.utf8_bytes + b.utf8_bytes,
    utf16_units: a.utf16_units + b.utf16_units,
  };
}

// Snap float noise (26 * 0.00008 = 0.00208000000003) before flooring or ceiling.
const micro = (n: number) => Math.round(n * 1e9) / 1e3;
const floorUsd = (n: number) => Math.floor(micro(n)) / 1e6;
const ceilUsd = (n: number) => Math.ceil(micro(n)) / 1e6;
const roundUsd = (n: number) => Math.round(n * 1e6) / 1e6;

function unknown(
  req: EstimateRequest,
  text: TextUnits,
  at: Date,
  reason: string,
  detail: string,
): CostEstimate {
  return {
    status: "unknown",
    reason,
    detail,
    currency: "USD",
    provider: req.provider,
    model: req.model,
    low_usd: null,
    expected_usd: null,
    high_usd: null,
    upper_bound: "none",
    text,
    units: {},
    assumptions: [],
    at: at.toISOString(),
  };
}

/** Units per meter for the request, as a range. */
function meterRanges(
  meters: Set<PriceMeter>,
  text: TextUnits,
  all: TextUnits,
  audioSeconds: number | undefined,
  assumptions: string[],
): CostEstimate["units"] | undefined {
  const units: CostEstimate["units"] = {};
  if (meters.has("requests")) units.requests = { low: 1, expected: 1, high: 1 };
  if (meters.has("characters")) {
    // A provider may count UTF-16 units: the high end takes the larger count.
    const high = Math.max(all.characters, all.utf16_units);
    units.characters = { low: text.characters, expected: text.characters, high };
    if (all.characters > text.characters) {
      assumptions.push("High end also bills the context/style text sent with the request.");
    }
    if (all.utf16_units > all.characters) {
      assumptions.push("High end counts emoji and other astral characters as two characters.");
    }
  }
  if (meters.has("utf8_bytes")) {
    units.utf8_bytes = { low: text.utf8_bytes, expected: text.utf8_bytes, high: all.utf8_bytes };
  }
  if (meters.has("input_text_tokens")) {
    units.input_text_tokens = {
      low: Math.ceil(text.characters / 6),
      expected: Math.ceil(all.characters / 4) + PROMPT_OVERHEAD_TOKENS,
      // A byte-level tokenizer never needs more than one token per UTF-8 byte.
      high: all.utf8_bytes + PROMPT_OVERHEAD_TOKENS,
    };
    assumptions.push(
      "Input tokens: about 4 characters per token; at most one token per UTF-8 byte.",
    );
  }
  if (meters.has("input_audio_seconds") && audioSeconds !== undefined) {
    const s = Math.round(audioSeconds * 1000) / 1000;
    const billed = Math.ceil((s * AUDIO_LENGTH_MARGIN) / BILLING_INCREMENT_SECONDS);
    units.input_audio_seconds = {
      low: s,
      expected: s,
      high: Math.max(1, billed) * BILLING_INCREMENT_SECONDS,
    };
    assumptions.push(
      `Audio billed per second of input; the high end adds ${Math.round((AUDIO_LENGTH_MARGIN - 1) * 100)}% to the measured length and rounds up to a whole minute.`,
    );
  }
  if (meters.has("output_audio_tokens") || meters.has("output_audio_seconds")) {
    const sec = (cps: number) => Math.max(1, text.characters / cps);
    const seconds = {
      low: Math.round(sec(CHARS_PER_SECOND.fast) * 10) / 10,
      expected: Math.round(sec(CHARS_PER_SECOND.typical) * 10) / 10,
      high: Math.round(sec(CHARS_PER_SECOND.slow) * 10) / 10,
    };
    units.output_audio_seconds = seconds;
    if (meters.has("output_audio_tokens")) {
      units.output_audio_tokens = {
        low: Math.ceil(seconds.low * GEMINI_AUDIO_TOKENS_PER_SECOND),
        expected: Math.ceil(seconds.expected * GEMINI_AUDIO_TOKENS_PER_SECOND),
        high: Math.ceil(seconds.high * GEMINI_AUDIO_TOKENS_PER_SECOND),
      };
    }
    assumptions.push(
      `Audio length: ${CHARS_PER_SECOND.slow}-${CHARS_PER_SECOND.fast} characters per second of speech (typical ${CHARS_PER_SECOND.typical}); the model decides the real length, so the high end is not a hard cap.`,
    );
  }
  for (const m of meters) if (!units[m]) return undefined;
  return units;
}

/** Estimate one request. Never throws for a missing price: returns status "unknown". */
export function estimateCost(req: EstimateRequest): CostEstimate {
  const at = req.at ?? new Date();
  const text = countText(req.text);
  const all = (req.extra_text ?? []).filter(Boolean).map(countText).reduce(addUnits, text);
  const lookup = resolveRate(req.provider, req.model, at);
  if (!lookup.ok) return unknown(req, text, at, lookup.reason, lookup.detail);
  const { rate } = lookup;
  const assumptions: string[] = [];
  const meters = new Set(rate.components.map((c) => c.meter));
  const seconds = req.audio_seconds;
  if (meters.has("input_audio_seconds") && !(Number.isFinite(seconds) && (seconds ?? 0) > 0)) {
    return unknown(
      req,
      text,
      at,
      "missing_input",
      `${rate.id} bills seconds of audio, and the length of the input audio is not known (pass a local file that ffprobe can read)`,
    );
  }
  const units = meterRanges(meters, text, all, seconds, assumptions);
  if (!units) {
    return unknown(req, text, at, "unsupported", `Cannot count units for ${rate.id}`);
  }
  let low = 0;
  let expected = 0;
  let high = 0;
  for (const c of rate.components) {
    const range = units[c.meter] as UnitRange;
    low += priceOf(rate.components, c.meter, range.low) ?? 0;
    expected += priceOf(rate.components, c.meter, range.expected) ?? 0;
    high += priceOf(rate.upper_components, c.meter, range.high) ?? 0;
  }
  if (rate.label === "promotion" && rate.effective_until) {
    assumptions.push(`Promotional price ends ${rate.effective_until}.`);
  }
  if (
    rate.upper_components.some(
      (u) => !rate.components.some((c) => c.usd === u.usd && c.meter === u.meter),
    )
  ) {
    assumptions.push("A price change is within a day: the high end uses the higher price.");
  }
  const proven = !["output_audio_tokens", "output_audio_seconds", "input_text_tokens"].some((m) =>
    meters.has(m as PriceMeter),
  );
  return {
    status: "estimated",
    currency: "USD",
    provider: req.provider,
    model: req.model,
    low_usd: floorUsd(low),
    expected_usd: roundUsd(expected),
    high_usd: ceilUsd(high),
    upper_bound: proven ? "proven" : "estimated",
    text,
    units,
    rate: {
      id: rate.id,
      tier: rate.tier,
      components: rate.components,
      ...(rate.label ? { label: rate.label } : {}),
      ...(rate.effective_from ? { effective_from: rate.effective_from } : {}),
      ...(rate.effective_until ? { effective_until: rate.effective_until } : {}),
      last_checked: rate.last_checked,
      source: rate.source,
      ...(rate.notes ? { notes: rate.notes } : {}),
    },
    assumptions,
    at: at.toISOString(),
  };
}
