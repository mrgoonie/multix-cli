/**
 * Prices that providers publish in their own model listings, read live so a
 * catalogue page can show more than the verified rate cards. These are
 * provider-listed figures in the provider's units: multix does not verify
 * them and never uses them for budgets or receipts. A unit the listing does
 * not state stays `null` (shown as "unit not stated"), never guessed.
 *
 * Runtime-neutral (no node:* imports): the caller passes fetch and any key.
 */

import type { Task } from "../capabilities/capability-types.js";
import { type FetchFn, readCatalog } from "../capabilities/model-discovery.js";

export const LIVE_SCHEMA = "multix.live-prices/v1";

/** One price figure from a provider listing. */
export interface ListedPrice {
  /** The listing's own name for the figure ("prompt", "image_output", "base_price"). */
  label: string;
  usd: number;
  /** Billing unit as the listing states it; null when the listing states none. */
  unit: string | null;
}

export interface LiveListing {
  provider: string;
  model: string;
  task: Task;
  name?: string;
  status?: string;
  released_at?: string;
  prices: ListedPrice[];
}

export interface LiveSource {
  provider: string;
  url: string;
  state: "fresh" | "unavailable" | "skipped";
  fetched_at: string;
  count: number;
  /** Why a source is unavailable or skipped (never a key). */
  detail?: string;
}

export interface LiveSnapshot {
  schema: typeof LIVE_SCHEMA;
  fetched_at: string;
  sources: LiveSource[];
  listings: LiveListing[];
}

const TIMEOUT_MS = 15_000;

/** OpenRouter pricing keys and the unit each is billed in (https://openrouter.ai/docs/api-reference/list-available-models). */
const OPENROUTER_UNITS: Record<string, string> = {
  prompt: "input token",
  completion: "output token",
  image: "input image",
  image_token: "image token",
  image_output: "output image token",
  audio: "audio token",
  input_audio_cache: "cached audio token",
  internal_reasoning: "reasoning token",
  input_cache_read: "cached input token",
  input_cache_write: "cache write token",
  request: "request",
  web_search: "search",
};

function positivePrices(entries: Array<[string, unknown, string | null]>): ListedPrice[] {
  const out: ListedPrice[] = [];
  for (const [label, value, unit] of entries) {
    const usd = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(usd) && usd > 0) out.push({ label, usd, unit });
  }
  return out;
}

const OPENROUTER_TASKS: Task[] = ["image", "image-edit", "speech", "transcription"];
const FAL_TASKS: Task[] = [
  "image",
  "image-edit",
  "video",
  "image-to-video",
  "video-edit",
  "speech",
  "transcription",
];

async function readOpenRouter(fetchFn: FetchFn, at: string) {
  const listings: LiveListing[] = [];
  const sources: LiveSource[] = [];
  for (const task of OPENROUTER_TASKS) {
    try {
      const read = await readCatalog("openrouter", task, fetchFn);
      for (const m of read.models) {
        listings.push({
          provider: "openrouter",
          model: m.model,
          task,
          ...(m.name ? { name: m.name } : {}),
          ...(m.status ? { status: m.status } : {}),
          ...(m.released_at ? { released_at: m.released_at } : {}),
          prices: positivePrices(
            Object.entries(m.pricing ?? {}).map(([k, v]) => [k, v, OPENROUTER_UNITS[k] ?? null]),
          ),
        });
      }
      sources.push({
        provider: "openrouter",
        url: read.url,
        state: "fresh",
        fetched_at: at,
        count: read.models.length,
      });
    } catch (e) {
      sources.push(
        unavailable("openrouter", `https://openrouter.ai/api/v1/models (${task})`, at, e),
      );
    }
  }
  return { listings, sources };
}

function unavailable(provider: string, url: string, at: string, e: unknown): LiveSource {
  return {
    provider,
    url,
    state: "unavailable",
    fetched_at: at,
    count: 0,
    detail: e instanceof Error ? e.message : String(e),
  };
}

interface FalPrice {
  endpoint_id?: unknown;
  unit_price?: unknown;
  unit?: unknown;
  currency?: unknown;
}

/** Most fal pricing requests one snapshot may make (Workers cap subrequests per request). */
const FAL_PRICING_MAX_REQUESTS = 150;

/**
 * fal prices per endpoint (https://docs.fal.ai/platform-apis/v1/models/pricing); needs a key.
 * fal answers 404 for a whole batch when one id in it has no price, so a 404
 * batch is split in half until the unpriced ids are isolated and skipped.
 */
async function readFalPrices(
  fetchFn: FetchFn,
  key: string,
  ids: string[],
): Promise<Map<string, ListedPrice>> {
  const prices = new Map<string, ListedPrice>();
  const queue: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) queue.push(ids.slice(i, i + 50));
  let requests = 0;
  while (queue.length && requests < FAL_PRICING_MAX_REQUESTS) {
    const batch = queue.shift() as string[];
    const query = batch.map((id) => `endpoint_id=${encodeURIComponent(id)}`).join("&");
    requests++;
    const res = await fetchFn(`https://api.fal.ai/v1/models/pricing?${query}`, {
      headers: { authorization: `Key ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) {
      if (batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        queue.unshift(batch.slice(0, mid), batch.slice(mid));
      }
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from api.fal.ai pricing`);
    const body = (await res.json()) as { prices?: FalPrice[] };
    for (const p of body.prices ?? []) {
      const usd = Number(p.unit_price);
      if (typeof p.endpoint_id !== "string" || p.currency !== "USD" || !(usd > 0)) continue;
      prices.set(p.endpoint_id, {
        label: "unit_price",
        usd,
        unit: typeof p.unit === "string" && p.unit ? p.unit : null,
      });
    }
  }
  return prices;
}

async function readFal(fetchFn: FetchFn, at: string, key?: string) {
  // The anonymous listing is rate limited; with a key, send it so the listing reads reliably.
  const listFetch: FetchFn = key
    ? (input, init) => fetchFn(input, { ...init, headers: { authorization: `Key ${key}` } })
    : fetchFn;
  const listings: LiveListing[] = [];
  const sources: LiveSource[] = [];
  for (const task of FAL_TASKS) {
    try {
      const read = await readCatalog("fal", task, listFetch);
      for (const m of read.models) {
        listings.push({
          provider: "fal",
          model: m.model,
          task,
          ...(m.name ? { name: m.name } : {}),
          ...(m.status ? { status: m.status } : {}),
          ...(m.released_at ? { released_at: m.released_at } : {}),
          prices: [],
        });
      }
      sources.push({
        provider: "fal",
        url: read.url,
        state: "fresh",
        fetched_at: at,
        count: read.models.length,
        ...(read.truncated ? { detail: "listing truncated" } : {}),
      });
    } catch (e) {
      sources.push(unavailable("fal", `https://api.fal.ai/v1/models (${task})`, at, e));
    }
  }
  const pricingUrl = "https://api.fal.ai/v1/models/pricing";
  if (!key) {
    sources.push({
      provider: "fal",
      url: pricingUrl,
      state: "skipped",
      fetched_at: at,
      count: 0,
      detail: "no pricing key configured",
    });
    return { listings, sources };
  }
  try {
    const prices = await readFalPrices(fetchFn, key, [...new Set(listings.map((l) => l.model))]);
    for (const l of listings) {
      const p = prices.get(l.model);
      if (p) l.prices = [p];
    }
    sources.push({
      provider: "fal",
      url: pricingUrl,
      state: "fresh",
      fetched_at: at,
      count: prices.size,
    });
  } catch (e) {
    sources.push(unavailable("fal", pricingUrl, at, e));
  }
  return { listings, sources };
}

const ATLAS_URL = "https://api.atlascloud.ai/api/v1/models";

/** Atlas listing category to multix task; categories without a task are left out. */
const ATLAS_TASKS: Record<string, Task> = {
  "TEXT-TO-IMAGE": "image",
  "IMAGE-TO-IMAGE": "image-edit",
  "IMAGE-TOOLS": "image-edit",
  "TEXT-TO-VIDEO": "video",
  "IMAGE-TO-VIDEO": "image-to-video",
  "VIDEO-TO-VIDEO": "video-edit",
  "AUDIO-TO-VIDEO": "avatar-video",
  "TEXT-TO-SPEECH": "speech",
  "TEXT-TO-AUDIO": "music",
  "SPEECH-TO-TEXT": "transcription",
  "IMAGE-TO-3D": "3d",
  "TEXT-TO-3D": "3d",
};

interface AtlasModel {
  model?: unknown;
  type?: unknown;
  displayName?: unknown;
  categories?: unknown;
  price?: { actual?: { base_price?: unknown; unit?: unknown } };
}

async function readAtlas(fetchFn: FetchFn, at: string) {
  const listings: LiveListing[] = [];
  try {
    const res = await fetchFn(ATLAS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from api.atlascloud.ai`);
    const body = (await res.json()) as { data?: AtlasModel[] };
    if (!Array.isArray(body.data)) throw new Error("Atlas listing has no data list");
    for (const m of body.data) {
      if (typeof m.model !== "string" || m.type === "Text") continue;
      const cats = Array.isArray(m.categories) ? m.categories : [];
      const tasks = [
        ...new Set(cats.map((c) => ATLAS_TASKS[String(c)]).filter((t): t is Task => !!t)),
      ];
      const actual = m.price?.actual;
      const unit = typeof actual?.unit === "string" && actual.unit ? actual.unit : null;
      for (const task of tasks) {
        listings.push({
          provider: "atlas",
          model: m.model,
          task,
          ...(typeof m.displayName === "string" ? { name: m.displayName } : {}),
          prices: positivePrices([["base_price", actual?.base_price, unit]]),
        });
      }
    }
    return {
      listings,
      sources: [
        {
          provider: "atlas",
          url: ATLAS_URL,
          state: "fresh" as const,
          fetched_at: at,
          count: listings.length,
        },
      ],
    };
  } catch (e) {
    return { listings, sources: [unavailable("atlas", ATLAS_URL, at, e)] };
  }
}

/**
 * Read every public provider listing multix knows how to price. One failing
 * provider never fails the snapshot: its source says "unavailable".
 */
export async function readLiveListings(
  fetchFn: FetchFn,
  opts: { falKey?: string; now?: Date } = {},
): Promise<LiveSnapshot> {
  const at = (opts.now ?? new Date()).toISOString();
  const parts = await Promise.all([
    readOpenRouter(fetchFn, at),
    readFal(fetchFn, at, opts.falKey),
    readAtlas(fetchFn, at),
  ]);
  return {
    schema: LIVE_SCHEMA,
    fetched_at: at,
    sources: parts.flatMap((p) => p.sources),
    listings: parts.flatMap((p) => p.listings),
  };
}
