/**
 * Data behind the public /models page and /models.json: every model multix
 * knows, with the best price source for each row, in this order:
 * 1. verified rate cards shipped with multix (src/catalog/catalog-build.ts);
 * 2. prices providers publish in their live model listings (cached here);
 * 3. none: the row links to the provider's own pricing page instead.
 * A missing price is never shown as $0.
 */

import { COMMAND_CAPABILITIES } from "../../../src/capabilities/command-capabilities.js";
import type { FetchFn } from "../../../src/capabilities/model-discovery.js";
import { MODEL_CAPABILITIES } from "../../../src/capabilities/model-registry.js";
import {
  PROVIDER_INFO,
  buildOfferings,
  withReleaseDates,
} from "../../../src/catalog/catalog-build.js";
import type { RateView } from "../../../src/catalog/catalog-types.js";
import {
  type ListedPrice,
  type LiveSnapshot,
  type LiveSource,
  readLiveListings,
} from "../../../src/catalog/live-listings.js";

export const MODELS_SCHEMA = "multix.models-page/v1";

/** How long a live snapshot is reused before providers are asked again. */
export const LIVE_TTL_S = 6 * 60 * 60;
const CACHE_KEY = "https://multix.internal/cache/live-prices/v2";

export type RowKind = "verified" | "catalog" | "listed" | "command";

export interface ModelRow {
  id: string;
  kind: RowKind;
  provider: string;
  model: string;
  name?: string;
  family?: string;
  tasks: string[];
  command?: string;
  released_at?: string;
  /** Verified multix rate cards (current or the reason they cannot be used). */
  rates: RateView[];
  /** Figures from the provider's live listing, in its units; not verified by multix. */
  listed: ListedPrice[];
  /** Provider page to check the price on when none is known. */
  price_link?: string;
}

export interface ModelsData {
  schema: typeof MODELS_SCHEMA;
  generated_at: string;
  live_fetched_at?: string;
  sources: LiveSource[];
  providers: Record<string, { name: string; homepage: string; pricing_url?: string }>;
  rows: ModelRow[];
}

/** Read the live snapshot from the Workers cache, refreshing it after LIVE_TTL_S. */
export async function liveSnapshot(fetchFn: FetchFn, falKey?: string): Promise<LiveSnapshot> {
  const cache =
    typeof caches === "undefined" ? undefined : (caches as unknown as { default: Cache }).default;
  const hit = await cache?.match(CACHE_KEY);
  if (hit) return (await hit.json()) as LiveSnapshot;
  const snap = await readLiveListings(fetchFn, { falKey });
  // A snapshot in which every source failed is not cached, so the next visit retries.
  if (cache && snap.sources.some((s) => s.state === "fresh")) {
    await cache.put(
      CACHE_KEY,
      new Response(JSON.stringify(snap), {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${LIVE_TTL_S}`,
        },
      }),
    );
  }
  return snap;
}

function priceLink(provider: string): string | undefined {
  const info = PROVIDER_INFO[provider];
  return info?.pricing_url ?? info?.homepage;
}

/** Merge shipped offerings, live listings and command routes into page rows. */
export function buildModelsData(snap: LiveSnapshot | undefined, at: Date = new Date()): ModelsData {
  const listings = snap?.listings ?? [];
  const live = new Map<string, (typeof listings)[number][]>();
  for (const l of listings) {
    const key = `${l.provider}:${l.model}`;
    live.set(key, [...(live.get(key) ?? []), l]);
  }
  const released = (p: string, m: string) =>
    live.get(`${p}:${m}`)?.find((l) => l.released_at)?.released_at;
  const offerings = withReleaseDates(buildOfferings(at), (p, m) => {
    const r = released(p, m);
    return r ? { released_at: r, released_source: "provider_listing" } : undefined;
  });
  const verified = new Set(MODEL_CAPABILITIES.map((c) => `${c.provider}:${c.model}`));
  const rows: ModelRow[] = offerings.map((o) => {
    const extra = live.get(o.id) ?? [];
    return {
      id: o.id,
      kind: verified.has(o.id) ? "verified" : "catalog",
      provider: o.provider,
      model: o.model,
      ...(o.name ? { name: o.name } : {}),
      ...(o.family ? { family: o.family } : {}),
      tasks: [...new Set([...o.tasks, ...extra.map((l) => l.task)])],
      ...(o.command ? { command: o.command } : {}),
      ...(o.released_at ? { released_at: o.released_at } : {}),
      rates: o.rates,
      listed: extra[0]?.prices ?? [],
      ...(o.price_status === "priced" ? {} : { price_link: priceLink(o.provider) }),
    };
  });
  const seen = new Set(rows.map((r) => r.id));
  for (const [id, ls] of live) {
    if (seen.has(id)) continue;
    const first = ls[0];
    if (!first) continue;
    seen.add(id);
    const name = ls.find((l) => l.name)?.name;
    const prices = ls.find((l) => l.prices.length)?.prices ?? [];
    rows.push({
      id,
      kind: "listed",
      provider: first.provider,
      model: first.model,
      ...(name ? { name } : {}),
      tasks: [...new Set(ls.map((l) => l.task))],
      ...(first.released_at ? { released_at: first.released_at } : {}),
      rates: [],
      listed: prices,
      ...(prices.length ? {} : { price_link: priceLink(first.provider) }),
    });
  }
  const covered = new Set(rows.flatMap((r) => r.tasks.map((t) => `${r.provider}|${t}`)));
  for (const [command, cap] of Object.entries(COMMAND_CAPABILITIES)) {
    const provider = command.split(" ")[0] ?? command;
    if (!PROVIDER_INFO[provider]) continue;
    for (const task of cap.tasks) {
      if (task === "any" || covered.has(`${provider}|${task}`)) continue;
      covered.add(`${provider}|${task}`);
      rows.push({
        id: `${provider}|${task}|${command}`,
        kind: "command",
        provider,
        model: `multix ${command}`,
        tasks: [task],
        command,
        rates: [],
        listed: [],
        price_link: priceLink(provider),
      });
    }
  }
  const providers: ModelsData["providers"] = {};
  for (const [id, p] of Object.entries(PROVIDER_INFO)) {
    providers[id] = {
      name: p.name,
      homepage: p.homepage,
      ...(p.pricing_url ? { pricing_url: p.pricing_url } : {}),
    };
  }
  return {
    schema: MODELS_SCHEMA,
    generated_at: at.toISOString(),
    ...(snap ? { live_fetched_at: snap.fetched_at } : {}),
    sources: snap?.sources ?? [],
    providers,
    rows,
  };
}
