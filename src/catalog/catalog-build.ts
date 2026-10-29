/**
 * Builds the catalogue from the sources multix already keeps: verified model
 * capabilities (src/capabilities/model-registry.ts), the audio price book
 * (src/budget/pricing-catalog.ts) and the configured rate cards
 * (rate-cards.ts). Nothing here fetches or guesses: an offering without a
 * current, verified, fresh price says why instead of showing $0.
 * Runtime-neutral; key readiness comes from the caller.
 */

import { type PriceEntry, type PriceMeter, resolveRate } from "../budget/pricing-catalog.js";
import { PRICING_CATALOG } from "../budget/pricing-catalog.js";
import type { Task } from "../capabilities/capability-types.js";
import { MODEL_CAPABILITIES } from "../capabilities/model-registry.js";
import type {
  Offering,
  OfferingConfig,
  ProviderView,
  RateCard,
  RateProblem,
  RateView,
} from "./catalog-types.js";
import { RATE_CARDS } from "./rate-cards.js";

/** Provider facts multix links to; ids are the CLI command groups. */
export const PROVIDER_INFO: Readonly<
  Record<string, { name: string; homepage: string; pricing_url?: string; docs_url?: string }>
> = {
  gemini: {
    name: "Google Gemini API",
    homepage: "https://ai.google.dev",
    pricing_url: "https://ai.google.dev/gemini-api/docs/pricing",
    docs_url: "https://ai.google.dev/gemini-api/docs",
  },
  openai: {
    name: "OpenAI",
    homepage: "https://platform.openai.com",
    pricing_url: "https://openai.com/api/pricing/",
    docs_url: "https://platform.openai.com/docs",
  },
  openrouter: {
    name: "OpenRouter",
    homepage: "https://openrouter.ai",
    pricing_url: "https://openrouter.ai/models",
    docs_url: "https://openrouter.ai/docs",
  },
  fal: {
    name: "fal",
    homepage: "https://fal.ai",
    pricing_url: "https://fal.ai/pricing",
    docs_url: "https://docs.fal.ai",
  },
  atlas: {
    name: "Atlas Cloud",
    homepage: "https://www.atlascloud.ai",
    pricing_url: "https://www.atlascloud.ai/pricing/models",
  },
  replicate: {
    name: "Replicate",
    homepage: "https://replicate.com",
    pricing_url: "https://replicate.com/pricing",
    docs_url: "https://replicate.com/docs",
  },
  elevenlabs: {
    name: "ElevenLabs",
    homepage: "https://elevenlabs.io",
    pricing_url: "https://elevenlabs.io/pricing/api",
    docs_url: "https://elevenlabs.io/docs",
  },
  fish: {
    name: "Fish Audio",
    homepage: "https://fish.audio",
    pricing_url: "https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits",
    docs_url: "https://docs.fish.audio",
  },
  minimax: {
    name: "MiniMax",
    homepage: "https://www.minimax.io",
  },
  leonardo: {
    name: "Leonardo.Ai",
    homepage: "https://leonardo.ai",
    docs_url: "https://docs.leonardo.ai",
  },
  byteplus: {
    name: "BytePlus ModelArk",
    homepage: "https://www.byteplus.com/en/product/modelark",
  },
  cloudflare: {
    name: "Cloudflare Workers AI",
    homepage: "https://developers.cloudflare.com/workers-ai/",
    pricing_url: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
  },
  runway: {
    name: "Runway",
    homepage: "https://runwayml.com",
  },
  heygen: { name: "HeyGen", homepage: "https://www.heygen.com" },
};

/** Task of an audio price, from what it meters. */
function taskOfMeters(meters: PriceMeter[]): Task {
  if (meters.includes("input_audio_seconds")) return "transcription";
  if (meters.includes("requests")) return "voice";
  return "speech";
}

function unitText(meter: PriceMeter, usd: number, per: number): string {
  return `USD ${usd} per ${per === 1 ? "" : `${per} `}${meter}`;
}

function cardOf(entry: PriceEntry): Partial<RateCard> {
  return entry as Partial<RateCard>;
}

/** A price entry as it stands at `at`: current, or the reason it cannot be used. */
export function rateView(entry: PriceEntry, model: string, at: Date): RateView {
  const lookup = resolveRate(entry.provider, model, at, [entry]);
  const extra = cardOf(entry);
  const base = {
    id: entry.id,
    tier: entry.tier,
    currency: entry.currency,
    basis: extra.basis ?? "list",
    config: extra.config ?? {},
    ...(extra.config_independent ? { config_independent: extra.config_independent } : {}),
    ...(extra.token_fps ? { token_fps: extra.token_fps } : {}),
    last_checked: entry.last_checked,
    source: entry.source,
    ...(entry.notes ? { notes: entry.notes } : {}),
  } as const;
  if (!lookup.ok) {
    return { ...base, status: lookup.reason, detail: lookup.detail, units: [] };
  }
  const r = lookup.rate;
  return {
    ...base,
    status: "current",
    components: r.components,
    units: r.components.map((c) => unitText(c.meter, c.usd, c.per)),
    ...(r.label ? { label: r.label } : {}),
    ...(r.effective_from ? { effective_from: r.effective_from } : {}),
    ...(r.effective_until ? { effective_until: r.effective_until } : {}),
  };
}

function priceStatus(rates: RateView[]): Offering["price_status"] {
  if (rates.some((r) => r.status === "current")) return "priced";
  return (rates[0]?.status as RateProblem | undefined) ?? "no_price";
}

/** Every offering multix knows a capability or a price for, at `at`. */
export function buildOfferings(at: Date = new Date()): Offering[] {
  const byId = new Map<string, Omit<Offering, "price_status">>();
  const get = (provider: string, model: string) => {
    const id = `${provider}:${model}`;
    let o = byId.get(id);
    if (!o) {
      o = { id, provider, model, tasks: [], verified_capability: false, rates: [] };
      byId.set(id, o);
    }
    return o;
  };
  const addTask = (o: { tasks: Task[] }, task: Task) => {
    if (!o.tasks.includes(task)) o.tasks.push(task);
  };

  for (const cap of MODEL_CAPABILITIES) {
    const o = get(cap.provider, cap.model);
    o.name = cap.name;
    o.command = cap.command;
    o.verified_capability = true;
    for (const t of cap.tasks) addTask(o, t);
  }
  for (const entry of PRICING_CATALOG) {
    const task = taskOfMeters(entry.windows.flatMap((w) => w.components.map((c) => c.meter)));
    for (const model of entry.models) {
      const o = get(entry.provider, model);
      addTask(o, task);
      o.rates.push(rateView(entry, model, at));
    }
  }
  for (const card of RATE_CARDS) {
    for (const model of card.models) {
      const o = get(card.provider, model);
      o.family = card.family;
      o.command ??=
        card.task === "image-to-video"
          ? `${card.provider} image-to-video`
          : `${card.provider} video`;
      addTask(o, card.task);
      o.rates.push(rateView(card, model, at));
    }
  }
  return [...byId.values()]
    .map((o) => ({ ...o, price_status: priceStatus(o.rates) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface OfferingFilter {
  task?: Task;
  provider?: string;
  family?: string;
  /** Case-insensitive text in id, name or family. */
  query?: string;
  /** Only offerings with a current price. */
  priced?: boolean;
  /** Only providers the caller has keys for. */
  ready?: (provider: string) => boolean;
  /** Matches any rate card with this resolution or audio setting. */
  resolution?: string;
  audio?: boolean;
}

function configMatches(o: Offering, key: keyof OfferingConfig, value: unknown): boolean {
  return o.rates.some((r) => r.config[key] === value || (r.config_independent ?? []).includes(key));
}

export function filterOfferings(offerings: Offering[], f: OfferingFilter): Offering[] {
  const q = f.query?.toLowerCase();
  return offerings.filter(
    (o) =>
      (!f.task || o.tasks.includes(f.task)) &&
      (!f.provider || o.provider === f.provider) &&
      (!f.family || o.family === f.family) &&
      (!q || [o.id, o.name ?? "", o.family ?? ""].some((s) => s.toLowerCase().includes(q))) &&
      (!f.priced || o.price_status === "priced") &&
      (!f.ready || f.ready(o.provider)) &&
      (f.resolution === undefined || configMatches(o, "resolution", f.resolution)) &&
      (f.audio === undefined || configMatches(o, "audio", f.audio)),
  );
}

export type OfferingSort = "id" | "provider" | "price" | "checked";

/** Lowest current per-unit price of an offering, as [meter, USD per unit]. */
function unitPrice(o: Offering): [string, number] | undefined {
  let best: [string, number] | undefined;
  for (const r of o.rates) {
    for (const c of r.components ?? []) {
      const v = c.usd / c.per;
      if (!best || c.meter < best[0] || (c.meter === best[0] && v < best[1])) best = [c.meter, v];
    }
  }
  return best;
}

/**
 * Sort offerings. "price" groups by billing unit first (a price per second and
 * a price per character are not comparable), then by USD per unit; offerings
 * without a current price come last.
 */
export function sortOfferings(offerings: Offering[], by: OfferingSort): Offering[] {
  const rows = [...offerings];
  if (by === "provider")
    rows.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  else if (by === "checked") {
    const latest = (o: Offering) =>
      o.rates
        .map((r) => r.last_checked)
        .sort()
        .at(-1) ?? "";
    rows.sort((a, b) => latest(b).localeCompare(latest(a)) || a.id.localeCompare(b.id));
  } else if (by === "price") {
    rows.sort((a, b) => {
      const pa = unitPrice(a);
      const pb = unitPrice(b);
      if (!pa || !pb) return pa ? -1 : pb ? 1 : a.id.localeCompare(b.id);
      return pa[0].localeCompare(pb[0]) || pa[1] - pb[1] || a.id.localeCompare(b.id);
    });
  } else rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}

/** Providers from the CLI groups the caller names plus every provider an offering uses. */
export function buildProviders(
  offerings: Offering[],
  groups: readonly string[],
  ready: (provider: string) => boolean,
): ProviderView[] {
  const ids = new Set([
    ...groups.filter((g) => PROVIDER_INFO[g]),
    ...offerings.map((o) => o.provider),
  ]);
  return [...ids].sort().map((id) => {
    const own = offerings.filter((o) => o.provider === id);
    const info = PROVIDER_INFO[id];
    return {
      id,
      name: info?.name ?? id,
      ...(info?.homepage ? { homepage: info.homepage } : {}),
      ...(info?.pricing_url ? { pricing_url: info.pricing_url } : {}),
      ...(info?.docs_url ? { docs_url: info.docs_url } : {}),
      ready: ready(id),
      offerings: own.length,
      priced_offerings: own.filter((o) => o.price_status === "priced").length,
    };
  });
}

/**
 * Find an offering by "<provider>:<model>", or by a model id that exactly one
 * provider offers. Returns every match so callers can say which ids are ambiguous.
 */
export function findOfferings(offerings: Offering[], ref: string): Offering[] {
  const exact = offerings.filter((o) => o.id === ref);
  if (exact.length) return exact;
  return offerings.filter((o) => o.model === ref);
}
