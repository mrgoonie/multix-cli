/**
 * The catalogue's price book and offering list, built from the sources multix
 * already trusts: the verified capability registry, the speech pricing
 * catalogue (src/budget) and the media rate cards. Every rate keeps its
 * source, check date and window; one that is stale, unverified or outside its
 * window is reported as such and never quoted. Quotes are made only for the
 * configuration the caller names and only when the rate's conditions match it:
 * a rate that does not confirm the resolution or audio setting asked for is
 * "not_equivalent", not cheaper.
 *
 * Runtime-neutral: the CLI (`multix catalog`) and the Worker (`multix_price_book`)
 * both call these builders, so the two surfaces cannot drift apart.
 */

import {
  MAX_PRICE_AGE_DAYS,
  PRICING_CATALOG,
  type PriceEntry,
  type PriceMeter,
  type PriceWindow,
} from "../budget/pricing-catalog.js";
import type { Task } from "../capabilities/capability-types.js";
import { COMMAND_CAPABILITIES } from "../capabilities/command-capabilities.js";
import { verifiedModels } from "../capabilities/model-registry.js";
import { catalogCommand } from "../capabilities/model-views.js";
import {
  CATALOG_SCHEMA,
  type OfferingView,
  type PriceStatus,
  type ProviderView,
  type Quote,
  type QuoteConfig,
  type RateFreshness,
  type RateView,
} from "./catalog-types.js";
import { MEDIA_RATE_CARDS, type MediaRateCard } from "./media-rate-cards.js";
import { CATALOG_PROVIDERS, PROVIDER_INFO } from "./provider-info.js";

export interface PriceBookSources {
  speech: readonly PriceEntry[];
  media: readonly MediaRateCard[];
}

export const DEFAULT_SOURCES: PriceBookSources = {
  speech: PRICING_CATALOG,
  media: MEDIA_RATE_CARDS,
};

/** Model family across providers: no vendor prefix, no date suffix, lower case. */
export function familyOf(model: string): string {
  const base = model.split("/").pop() ?? model;
  return base.replace(/-20\d{6}$/, "").toLowerCase();
}

export function freshnessOf(
  r: { verified: boolean; last_checked: string; from?: string; until?: string },
  at: Date,
): RateFreshness {
  const t = at.getTime();
  if (r.from !== undefined && t < Date.parse(r.from)) return "not_started";
  if (r.until !== undefined && t >= Date.parse(r.until)) return "expired";
  if (!r.verified) return "unverified";
  const ageDays = (t - Date.parse(`${r.last_checked}T00:00:00Z`)) / 86_400_000;
  return ageDays <= MAX_PRICE_AGE_DAYS ? "current" : "stale";
}

function speechTask(meters: PriceMeter[]): Task {
  return meters.includes("input_audio_seconds") ? "transcription" : "speech";
}

/** The window in force at `at`, else the next one to start, else the last. */
function windowAt(windows: PriceWindow[], at: Date): PriceWindow | undefined {
  const t = at.getTime();
  const inForce = windows.find(
    (w) =>
      (w.from === undefined || Date.parse(w.from) <= t) &&
      (w.until === undefined || t < Date.parse(w.until)),
  );
  if (inForce) return inForce;
  const upcoming = windows
    .filter((w) => w.from !== undefined && Date.parse(w.from) > t)
    .sort((a, b) => Date.parse(a.from ?? "") - Date.parse(b.from ?? ""));
  return upcoming[0] ?? windows[windows.length - 1];
}

function speechRates(entries: readonly PriceEntry[], at: Date): RateView[] {
  const rates: RateView[] = [];
  for (const e of entries) {
    const w = windowAt(e.windows, at);
    if (!w) continue;
    for (const model of e.models) {
      rates.push({
        id: e.id,
        provider: e.provider,
        model,
        family: familyOf(model),
        task: speechTask(w.components.map((c) => c.meter)),
        conditions: {},
        components: w.components.map((c) => ({ unit: c.meter, amount: c.usd, per: c.per })),
        currency: e.currency,
        billing: "api-payg",
        tier: e.tier,
        region: e.region,
        ...(w.from ? { effective_from: w.from } : {}),
        ...(w.until ? { effective_until: w.until } : {}),
        ...(w.label ? { label: w.label } : {}),
        last_checked: e.last_checked,
        source: e.source,
        freshness: freshnessOf({ ...e, ...w }, at),
        ...(e.notes ? { notes: e.notes } : {}),
      });
    }
  }
  return rates;
}

function mediaRates(cards: readonly MediaRateCard[], at: Date): RateView[] {
  return cards.flatMap((c) =>
    c.models.map((model) => ({
      id: c.id,
      provider: c.provider,
      model,
      family: c.family,
      task: c.task,
      conditions: c.conditions,
      components: c.components,
      currency: c.currency,
      ...(c.usd_per_credit !== undefined ? { usd_per_credit: c.usd_per_credit } : {}),
      billing: c.billing,
      tier: c.tier,
      region: c.region,
      ...(c.from ? { effective_from: c.from } : {}),
      ...(c.until ? { effective_until: c.until } : {}),
      ...(c.label ? { label: c.label } : {}),
      last_checked: c.last_checked,
      source: c.source,
      freshness: freshnessOf(c, at),
      ...(c.surcharges?.length ? { surcharges: c.surcharges } : {}),
      ...(c.notes ? { notes: c.notes } : {}),
    })),
  );
}

export function allRates(at: Date, sources: PriceBookSources = DEFAULT_SOURCES): RateView[] {
  return [...speechRates(sources.speech, at), ...mediaRates(sources.media, at)];
}

const refOf = (provider: string, model: string) => `${provider}:${model}`;

/** Split "<provider>:<model>"; the model may itself contain ":" or "/". */
export function parseRef(ref: string): { provider: string; model: string } | undefined {
  const i = ref.indexOf(":");
  if (i <= 0 || i === ref.length - 1) return undefined;
  return { provider: ref.slice(0, i).trim(), model: ref.slice(i + 1).trim() };
}

const STATUS_RANK: Record<PriceStatus, number> = { priced: 3, stale: 2, unverified: 1, unknown: 0 };

function priceStatus(rates: RateView[]): PriceStatus {
  let best: PriceStatus = "unknown";
  for (const r of rates) {
    const s: PriceStatus =
      r.freshness === "current" ? "priced" : r.freshness === "stale" ? "stale" : "unverified";
    if (STATUS_RANK[s] > STATUS_RANK[best]) best = s;
  }
  return best;
}

function mediaCommand(cards: readonly MediaRateCard[], provider: string, model: string) {
  return cards.find((c) => c.provider === provider && c.models.includes(model))?.command;
}

/** Every offering: verified registry models plus every model a rate is on file for. */
export function listOfferings(
  at: Date = new Date(),
  sources: PriceBookSources = DEFAULT_SOURCES,
): OfferingView[] {
  const rates = allRates(at, sources);
  const byRef = new Map<string, OfferingView>();
  const ratesOf = new Map<string, RateView[]>();
  for (const r of rates) {
    const ref = refOf(r.provider, r.model);
    ratesOf.set(ref, [...(ratesOf.get(ref) ?? []), r]);
  }
  for (const cap of verifiedModels()) {
    const ref = refOf(cap.provider, cap.model);
    byRef.set(ref, {
      ref,
      provider: cap.provider,
      model: cap.model,
      name: cap.name,
      family: familyOf(cap.model),
      tasks: [...cap.tasks],
      verified: true,
      command: cap.command,
      ...(cap.deprecated ? { deprecated: true } : {}),
      price_status: "unknown",
      rates: 0,
    });
  }
  for (const [ref, list] of ratesOf) {
    const first = list[0];
    if (!first) continue;
    const existing = byRef.get(ref);
    const tasks = [...new Set(list.map((r) => r.task).filter((t): t is Task => Boolean(t)))];
    const view: OfferingView = existing ?? {
      ref,
      provider: first.provider,
      model: first.model,
      family: first.family,
      tasks,
      verified: false,
      command:
        mediaCommand(sources.media, first.provider, first.model) ??
        tasks.map((t) => catalogCommand(first.provider, t)).find((c) => c !== null) ??
        null,
      price_status: "unknown",
      rates: 0,
    };
    view.price_status = priceStatus(list);
    view.rates = list.length;
    byRef.set(ref, view);
  }
  return [...byRef.values()].sort((a, b) => a.ref.localeCompare(b.ref));
}

export interface OfferingFilter {
  provider?: string;
  task?: Task;
  family?: string;
  /** Only offerings with a current price. */
  priced?: boolean;
  /** Only verified offerings. */
  verified?: boolean;
}

export function filterOfferings(list: OfferingView[], f: OfferingFilter): OfferingView[] {
  const family = f.family?.toLowerCase();
  return list.filter(
    (o) =>
      (!f.provider || o.provider === f.provider) &&
      (!f.task || o.tasks.includes(f.task)) &&
      (!family || o.family === family || o.family.startsWith(`${family}-`)) &&
      (!f.priced || o.price_status === "priced") &&
      (!f.verified || o.verified),
  );
}

export interface ProviderHooks {
  /** Key env names a group reads. */
  keys: (group: string) => string[];
  /** Whether the caller has them; null when the surface cannot tell. */
  ready: (group: string) => boolean | null;
}

export function listProviders(
  hooks: ProviderHooks,
  at: Date = new Date(),
  sources: PriceBookSources = DEFAULT_SOURCES,
): ProviderView[] {
  const offerings = listOfferings(at, sources);
  return CATALOG_PROVIDERS.map((provider) => {
    const info = PROVIDER_INFO[provider];
    const commands = Object.keys(COMMAND_CAPABILITIES).filter((c) => c.split(" ")[0] === provider);
    const tasks = new Set<Task>();
    for (const c of commands) for (const t of COMMAND_CAPABILITIES[c]?.tasks ?? []) tasks.add(t);
    const mine = offerings.filter((o) => o.provider === provider);
    return {
      provider,
      name: info?.name ?? provider,
      ...(info?.homepage ? { homepage: info.homepage } : {}),
      ...(info?.docs ? { docs: info.docs } : {}),
      ...(info?.pricing ? { pricing: info.pricing } : {}),
      tasks: [...tasks].sort(),
      commands,
      keys: hooks.keys(provider),
      ready: hooks.ready(provider),
      offerings: mine.length,
      priced_offerings: mine.filter((o) => o.price_status === "priced").length,
    };
  });
}

function fmt(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Quote one rate at one configuration; see QuoteStatus for what each outcome means. */
export function quoteRate(rate: RateView, config: QuoteConfig): Quote {
  const base = {
    ref: refOf(rate.provider, rate.model),
    provider: rate.provider,
    model: rate.model,
    rate_id: rate.id,
    freshness: rate.freshness,
    last_checked: rate.last_checked,
    source: rate.source,
    ...(rate.surcharges?.length ? { surcharges: rate.surcharges } : {}),
  };
  if (rate.freshness !== "current") {
    return {
      ...base,
      status: "unknown",
      amount: null,
      currency: null,
      reason: `rate is ${rate.freshness}; re-check ${rate.source}`,
    };
  }
  const c = rate.conditions;
  if (config.task && (c.mode ?? rate.task) && (c.mode ?? rate.task) !== config.task) {
    return {
      ...base,
      status: "not_equivalent",
      amount: null,
      currency: null,
      reason: `rate is for ${c.mode ?? rate.task}`,
    };
  }
  const unconfirmed: string[] = [];
  const mismatch: string[] = [];
  if (config.resolution !== undefined) {
    if (c.resolution === undefined) unconfirmed.push("resolution");
    else if (c.resolution.toLowerCase() !== config.resolution.toLowerCase()) {
      mismatch.push(`resolution ${c.resolution}`);
    }
  }
  if (config.aspect_ratio !== undefined) {
    if (c.aspect_ratio === undefined) unconfirmed.push("aspect ratio");
    else if (c.aspect_ratio !== config.aspect_ratio)
      mismatch.push(`aspect ratio ${c.aspect_ratio}`);
  }
  if (config.audio !== undefined) {
    if (c.audio === undefined) unconfirmed.push("audio");
    else if (c.audio !== "any" && c.audio !== config.audio) {
      mismatch.push(`audio ${c.audio ? "on" : "off"}`);
    }
  }
  if (config.duration_s !== undefined) {
    if (c.min_duration_s !== undefined && config.duration_s < c.min_duration_s) {
      mismatch.push(`duration from ${c.min_duration_s}s`);
    }
    if (c.max_duration_s !== undefined && config.duration_s > c.max_duration_s) {
      mismatch.push(`duration up to ${c.max_duration_s}s`);
    }
  }
  if (mismatch.length) {
    return {
      ...base,
      status: "not_equivalent",
      amount: null,
      currency: null,
      reason: `rate is for ${mismatch.join(", ")}`,
    };
  }
  if (unconfirmed.length) {
    return {
      ...base,
      status: "not_equivalent",
      amount: null,
      currency: null,
      unconfirmed,
      reason: `the source does not confirm ${unconfirmed.join(" or ")} for this rate`,
    };
  }
  const assumed = [
    ...(c.resolution !== undefined && config.resolution === undefined
      ? [`resolution ${c.resolution}`]
      : []),
    ...(c.aspect_ratio !== undefined && config.aspect_ratio === undefined
      ? [`aspect ratio ${c.aspect_ratio}`]
      : []),
    ...(typeof c.audio === "boolean" && config.audio === undefined
      ? [`audio ${c.audio ? "on" : "off"}`]
      : []),
  ];
  if (assumed.length) Object.assign(base, { assumed });
  const [only, ...more] = rate.components;
  const perUnit = only ? `${fmt(only.amount / only.per)} ${rate.currency}/${only.unit}` : "";
  if (!only || more.length) {
    return {
      ...base,
      status: "unit_only",
      amount: null,
      currency: rate.currency,
      reason: "billed on several meters measured at run time",
    };
  }
  let units: number | undefined;
  let basis: string | undefined;
  if (only.unit === "video_second" && config.duration_s !== undefined) {
    units = Math.max(config.duration_s, c.billed_min_duration_s ?? 0);
    basis = `${units} s x ${perUnit}`;
  } else if (only.unit === "video" || only.unit === "request" || only.unit === "requests") {
    units = 1;
    basis = `1 x ${perUnit}`;
  } else if (only.unit === "image") {
    units = config.count ?? 1;
    basis = `${units} image(s) x ${perUnit}`;
  }
  if (units === undefined) {
    return {
      ...base,
      status: "unit_only",
      amount: null,
      currency: rate.currency,
      basis: perUnit,
      reason:
        only.unit === "video_second"
          ? "give --duration to price a clip"
          : `billed per ${only.unit}, measured at run time`,
    };
  }
  return {
    ...base,
    status: "quoted",
    amount: fmt((units * only.amount) / only.per),
    currency: rate.currency,
    basis,
  };
}

const QUOTE_RANK: Record<Quote["status"], number> = {
  quoted: 3,
  unit_only: 2,
  not_equivalent: 1,
  unknown: 0,
};

/**
 * Which of two quotes of one offering to report: the more usable status; then,
 * between quotes, the lower amount; between non-equivalent ones, one that only
 * lacks confirmation over one that contradicts the configuration.
 */
export function betterQuote(q: Quote, prev: Quote): boolean {
  if (QUOTE_RANK[q.status] !== QUOTE_RANK[prev.status]) {
    return QUOTE_RANK[q.status] > QUOTE_RANK[prev.status];
  }
  if (q.status === "quoted")
    return (q.amount ?? Number.POSITIVE_INFINITY) < (prev.amount ?? Number.POSITIVE_INFINITY);
  if (q.status === "not_equivalent") return Boolean(q.unconfirmed) && !prev.unconfirmed;
  return false;
}

export interface Comparison {
  schema: typeof CATALOG_SCHEMA;
  family: string;
  config: QuoteConfig;
  at: string;
  /** Quotes for the same configuration and currency, cheapest first. */
  comparable: (Quote & { rank: number })[];
  /** Everything else, with the reason it cannot be ranked against them. */
  not_comparable: Quote[];
  /** Offerings of the family with no rate on file at all. */
  unpriced: string[];
  note: string;
}

/** Compare one model family across providers at one configuration. */
export function compareFamily(
  family: string,
  config: QuoteConfig,
  at: Date = new Date(),
  sources: PriceBookSources = DEFAULT_SOURCES,
): Comparison {
  const fam = family.toLowerCase();
  // Exact family only: "seedance-2.0-fast" is another model, not a cheaper "seedance-2.0".
  const matches = (f: string) => f === fam;
  const rates = allRates(at, sources).filter((r) => matches(r.family));
  const best = new Map<string, Quote>();
  for (const r of rates) {
    const q = quoteRate(r, config);
    const prev = best.get(q.ref);
    if (!prev || betterQuote(q, prev)) best.set(q.ref, q);
  }
  const quotes = [...best.values()];
  const usd = quotes
    .filter((q) => q.status === "quoted" && q.currency === "USD")
    .sort((a, b) => (a.amount ?? 0) - (b.amount ?? 0) || a.ref.localeCompare(b.ref));
  const ranked = new Set(usd);
  const priced = new Set(rates.map((r) => refOf(r.provider, r.model)));
  return {
    schema: CATALOG_SCHEMA,
    family: fam,
    config,
    at: at.toISOString(),
    comparable: usd.map((q, i) => ({ ...q, rank: i + 1 })),
    not_comparable: quotes
      .filter((q) => !ranked.has(q))
      .sort((a, b) => QUOTE_RANK[b.status] - QUOTE_RANK[a.status] || a.ref.localeCompare(b.ref)),
    unpriced: listOfferings(at, sources)
      .filter((o) => matches(o.family) && !priced.has(o.ref))
      .map((o) => o.ref),
    note: "List prices only, for the configuration given. A lower price says nothing about output quality; credits are not converted to USD unless the provider publishes the rate.",
  };
}

export interface OfferingDetail {
  schema: typeof CATALOG_SCHEMA;
  offering: OfferingView;
  rates: RateView[];
  provider: { name: string; docs?: string; pricing?: string };
}

export function showOffering(
  ref: string,
  at: Date = new Date(),
  sources: PriceBookSources = DEFAULT_SOURCES,
): OfferingDetail | undefined {
  const parsed = parseRef(ref);
  if (!parsed) return undefined;
  const offering = listOfferings(at, sources).find(
    (o) => o.provider === parsed.provider && o.model === parsed.model,
  );
  if (!offering) return undefined;
  const info = PROVIDER_INFO[offering.provider];
  return {
    schema: CATALOG_SCHEMA,
    offering,
    rates: allRates(at, sources).filter(
      (r) => r.provider === offering.provider && r.model === offering.model,
    ),
    provider: {
      name: info?.name ?? offering.provider,
      ...(info?.docs ? { docs: info.docs } : {}),
      ...(info?.pricing ? { pricing: info.pricing } : {}),
    },
  };
}
