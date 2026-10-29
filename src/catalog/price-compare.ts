/**
 * Configuration-aware quotes and comparisons. A quote prices one rate card
 * for one request (resolution, duration, audio, aspect ratio, images); a
 * comparison ranks only list prices whose rate card confirms every setting the
 * request pins, with nothing assumed. A card that does not state a setting the
 * request pins is "not_comparable"; a card without a current price is
 * "unknown" (null, never $0). An estimate, a quote that assumes a setting, and
 * a video card silent on audio next to a ranked card whose price holds with or
 * without audio stay priced but unranked, with the reason. Ranking is by price only and says
 * nothing about quality.
 */

import { type PriceMeter, priceOf } from "../budget/pricing-catalog.js";
import type { Task } from "../capabilities/capability-types.js";
import type {
  ConfigKey,
  Offering,
  OfferingConfig,
  QuoteRequest,
  QuoteRow,
  RateView,
} from "./catalog-types.js";
import { frameSize } from "./rate-cards.js";

const DEFAULT_ASPECT = "16:9";
const OTHER_CONFIG = "rate card is for another configuration";
const ESTIMATE =
  "the provider shows this price as an estimate and bills the final amount from the usage it measures";
const AUDIO_UNSTATED =
  "source does not state whether this price includes audio, while other prices here do";
/** Tasks whose output can carry generated audio. */
const AUDIO_TASKS: readonly Task[] = ["video", "image-to-video"];

const describe = (key: ConfigKey, value: unknown) =>
  key === "audio" ? `audio ${value ? "on" : "off"}` : `${key} ${String(value)}`;

/** Settings the request pins, in the rate-card shape. */
function pinned(req: QuoteRequest): OfferingConfig {
  return {
    ...(req.resolution !== undefined ? { resolution: req.resolution } : {}),
    ...(req.audio !== undefined ? { audio: req.audio } : {}),
    ...(req.aspect_ratio !== undefined ? { aspect_ratio: req.aspect_ratio } : {}),
  };
}

interface Match {
  ok: boolean;
  /** The card states a different value for a pinned setting: not this configuration. */
  differs: boolean;
  /** Pinned settings the card's source does not state. */
  unstated: ConfigKey[];
  /** Settings the card fixes that the request left open (the row is not pinned). */
  open: ConfigKey[];
}

function matchConfig(rate: RateView, want: OfferingConfig): Match {
  const independent = new Set(rate.config_independent ?? []);
  const unstated: ConfigKey[] = [];
  let differs = false;
  for (const [key, value] of Object.entries(want) as [ConfigKey, unknown][]) {
    if (independent.has(key)) continue;
    const has = rate.config[key];
    // The aspect ratio only changes a token-formula price; per-second prices do not state it.
    if (key === "aspect_ratio" && has === undefined) continue;
    if (has === undefined) unstated.push(key);
    else if (has !== value) differs = true;
  }
  // A priced extra (voice control) is a different product unless asked for.
  if (rate.config.variant !== undefined) differs = true;
  const open = (Object.keys(rate.config) as ConfigKey[]).filter(
    (k) => k !== "variant" && want[k] === undefined && k !== "aspect_ratio",
  );
  return { ok: !differs && unstated.length === 0, differs, unstated, open };
}

/** Units a request bills on one meter, or why they cannot be known. */
function unitsFor(
  meter: PriceMeter,
  req: QuoteRequest,
  rate: RateView,
  assumptions: string[],
): number | string {
  if (meter === "output_video_seconds") {
    return req.duration_s === undefined
      ? "pass a duration to price per-second video"
      : req.duration_s;
  }
  if (meter === "video_tokens") {
    if (req.duration_s === undefined) return "pass a duration to price token-billed video";
    const resolution = req.resolution ?? rate.config.resolution;
    if (!resolution) return "pass a resolution to price token-billed video";
    const aspect = req.aspect_ratio ?? rate.config.aspect_ratio ?? DEFAULT_ASPECT;
    if (req.aspect_ratio === undefined && rate.config.aspect_ratio === undefined) {
      assumptions.push(`aspect ratio ${DEFAULT_ASPECT} (frame size of the token formula)`);
    }
    const size = frameSize(resolution, aspect);
    if (!size) return `frame size of ${resolution} at ${aspect} is not on file`;
    if (!rate.token_fps) return "token formula frame rate is not on file";
    return Math.round((size[0] * size[1] * req.duration_s * rate.token_fps) / 1024);
  }
  if (meter === "output_images") return req.images ?? 1;
  return `quotes for ${meter} need the request text or audio; use --estimate on the command`;
}

/** Quote one rate of one offering for a request. */
export function quoteRate(offering: Offering, rate: RateView, req: QuoteRequest): QuoteRow {
  const head = {
    offering: offering.id,
    provider: offering.provider,
    model: offering.model,
    rate_id: rate.id,
    basis: rate.basis,
    source: rate.source,
    last_checked: rate.last_checked,
  };
  const match = matchConfig(rate, pinned(req));
  if (!match.ok) {
    const reasons = match.differs
      ? [OTHER_CONFIG]
      : match.unstated.map(
          (k) => `source does not state the price for ${describe(k, pinned(req)[k])}`,
        );
    return { ...head, status: "not_comparable", total_usd: null, reasons };
  }
  if (rate.status !== "current" || !rate.components) {
    return {
      ...head,
      status: "unknown",
      total_usd: null,
      reasons: [rate.detail ?? `price is ${rate.status}`],
    };
  }
  const assumptions: string[] = [];
  const units: Partial<Record<PriceMeter, number>> = {};
  let total = 0;
  for (const c of rate.components) {
    const n = unitsFor(c.meter, req, rate, assumptions);
    if (typeof n === "string") {
      return { ...head, status: "unknown", total_usd: null, reasons: [n] };
    }
    units[c.meter] = n;
    total += priceOf([c], c.meter, n) ?? 0;
  }
  const open = match.open.map((k) => describe(k, rate.config[k]));
  // Only a list price with nothing assumed is a price the source confirms.
  const unranked = [
    ...(rate.basis === "estimated" ? [ESTIMATE] : []),
    ...assumptions.map((a) => `the quote assumes ${a}; pin that setting to rank it`),
  ];
  return {
    ...head,
    status: "priced",
    total_usd: Math.round(total * 1e6) / 1e6,
    units,
    ...(assumptions.length ? { assumptions } : {}),
    ...(open.length ? { open_settings: open } : {}),
    ...(unranked.length ? { reasons: unranked } : {}),
  };
}

interface PricedQuote {
  row: QuoteRow;
  rate: RateView;
  tasks: readonly Task[];
}

const rankable = (r: QuoteRow) => r.status === "priced" && !r.open_settings && !r.reasons?.length;

/**
 * Audio left open by the request is open for every priced video card that does
 * not state it once another video card, itself ranked, confirms its price with
 * or without audio (fal: "audio does not change the token count"; Atlas does
 * not say whether audio is included): the silent rows are not ranked against
 * it. Cards that are all silent still rank against each other. Pinned audio is
 * settled per card by quoteRate.
 */
function markAudioUnstated(priced: PricedQuote[], req: QuoteRequest) {
  if (req.audio !== undefined) return;
  const video = priced.filter((p) => p.tasks.some((t) => AUDIO_TASKS.includes(t)));
  const covered = video.some(
    (p) => (p.rate.config_independent ?? []).includes("audio") && rankable(p.row),
  );
  if (!covered) return;
  for (const { row, rate } of video) {
    if (rate.config.audio !== undefined || (rate.config_independent ?? []).includes("audio")) {
      continue;
    }
    row.reasons = [...(row.reasons ?? []), AUDIO_UNSTATED];
  }
}

/** Why a priced row is not ranked (empty when it is ranked or not priced). */
export function notRankedReasons(r: QuoteRow): string[] {
  if (r.status !== "priced") return [];
  return [
    ...(r.open_settings?.length ? [`pin ${r.open_settings.join(", ")}`] : []),
    ...(r.reasons ?? []),
  ];
}

export interface Comparison {
  request: Omit<QuoteRequest, "at"> & { at: string };
  rows: QuoteRow[];
  /** Offerings without a row for this request and why. */
  note: string;
}

/**
 * Quote every rate card of the offerings for the request. Rows whose card
 * fixes a setting the request left open are priced but not ranked: pin the
 * setting to rank them. Estimates, quotes with assumptions and video cards
 * silent on audio that another ranked card covers are priced but not ranked
 * either; their reasons say why. Ties share a rank.
 */
export function compareOfferings(offerings: Offering[], req: QuoteRequest): Comparison {
  const rows: QuoteRow[] = [];
  const priced: PricedQuote[] = [];
  for (const o of offerings) {
    if (req.task && !o.tasks.includes(req.task)) continue;
    const quoted = o.rates.map((rate) => ({ rate, tasks: o.tasks, row: quoteRate(o, rate, req) }));
    priced.push(...quoted.filter((q) => q.row.status === "priced"));
    const quotes = quoted.map((q) => q.row);
    const useful = quotes.filter((q) => q.status !== "not_comparable");
    if (useful.length) rows.push(...useful);
    else if (quotes.length) {
      // The closest cards are those that only leave a pinned setting unstated.
      const close = quotes.filter((q) => !q.reasons?.includes(OTHER_CONFIG));
      const want = Object.entries(pinned(req)).map(([k, v]) => describe(k as ConfigKey, v));
      rows.push({
        offering: o.id,
        provider: o.provider,
        model: o.model,
        status: "not_comparable",
        total_usd: null,
        reasons: close.length
          ? [...new Set(close.flatMap((q) => q.reasons ?? []))]
          : [`no price on file for ${want.join(", ")}`],
      });
    } else {
      rows.push({
        offering: o.id,
        provider: o.provider,
        model: o.model,
        status: "unknown",
        total_usd: null,
        reasons: ["no price on file"],
      });
    }
  }
  markAudioUnstated(priced, req);
  const ranked = rows.filter(rankable);
  const sorted = [...new Set(ranked.map((r) => r.total_usd as number))].sort((a, b) => a - b);
  for (const r of ranked) r.price_rank = sorted.indexOf(r.total_usd as number) + 1;
  rows.sort(
    (a, b) =>
      (a.price_rank ?? Number.POSITIVE_INFINITY) - (b.price_rank ?? Number.POSITIVE_INFINITY) ||
      order(a) - order(b) ||
      a.offering.localeCompare(b.offering),
  );
  const { at, ...rest } = req;
  return {
    request: { ...rest, at: (at ?? new Date()).toISOString() },
    rows,
    note: "Ranked by quoted price for this exact configuration only, and only list prices the source confirms with nothing assumed; price says nothing about output quality. Unranked rows are unknown, not comparable, priced for a setting you did not pin, an estimate, based on an assumption, or or silent on audio that other prices state.",
  };
}

function order(r: QuoteRow): number {
  return r.status === "priced" ? 0 : r.status === "unknown" ? 1 : 2;
}
