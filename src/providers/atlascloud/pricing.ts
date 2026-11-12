/**
 * Atlas Cloud 3D prices (runtime-neutral: the caller passes fetch, caching
 * lives in the CLI layer).
 *
 * The public model list (GET /models) says which models are 3D
 * (IMAGE-TO-3D, TEXT-TO-3D). Its `price.actual.base_price` is NOT what a 3D
 * run costs: Atlas lists Hi3D v3.0 Master at base_price 0.017 and bills
 * $5.185 per model. The prices come from Atlas's public price list instead
 * (GET /pricing/models, the data behind https://www.atlascloud.ai/pricing/models):
 * one `price_rows` entry per configuration (`quote_defaults` names the
 * settings it applies to) and `pricing.request`, the price of a run with the
 * model's default settings. Each 3D run returns one model, so a row price is
 * the price of the run.
 */

import type { CostEstimate } from "../../budget/cost-estimate.js";
import type { DiscoveredModel, ListedPrice } from "../../capabilities/capability-types.js";
import type { CatalogRead, FetchFn } from "../../capabilities/model-discovery.js";
import type { RateCard } from "../../catalog/catalog-types.js";
import { DEFAULT_ATLAS_BASE_URL } from "./models.js";

export const ATLAS_MODELS_URL = `${DEFAULT_ATLAS_BASE_URL}/models`;
export const ATLAS_PRICING_URL = `${DEFAULT_ATLAS_BASE_URL}/pricing/models`;
/** The human page of the same price list (cited as the source). */
export const ATLAS_PRICING_PAGE = "https://www.atlascloud.ai/pricing/models";

/** Atlas categories of 3D models in GET /models. */
export const ATLAS_3D_CATEGORIES = ["IMAGE-TO-3D", "TEXT-TO-3D"] as const;

/** Prices older than this are not used to price a run (same limit as the model list cache). */
export const ATLAS_PRICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const REFRESH_HINT = "run `multix models --task 3d --live --refresh`";
const TIMEOUT_MS = 20_000;

/** The cached 3D price list a caller passes in to price a run. */
export interface Atlas3dPriceSnapshot {
  /** When the list was fetched (ISO 8601). */
  fetched_at: string;
  /** Why the list could not be read now, when it could not. */
  error?: string;
  models: DiscoveredModel[];
}

async function getJson(fetchFn: FetchFn, url: string): Promise<unknown> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const str = (v: unknown) => (typeof v === "string" ? v.replace(CONTROL, "").trim() : "");

/** A non-negative USD amount from a price string; anything else is no price. */
function usd(v: unknown): number | undefined {
  const s = typeof v === "number" ? String(v) : str(v);
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

type Setting = string | number | boolean;

function settings(v: unknown): Record<string, Setting> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out = Object.fromEntries(
    Object.entries(v).filter(
      (e): e is [string, Setting] =>
        typeof e[1] === "string" || typeof e[1] === "number" || typeof e[1] === "boolean",
    ),
  );
  return Object.keys(out).length ? out : undefined;
}

/** One model's prices from its GET /pricing/models entry; undefined when it lists none. */
export function listedPriceOf(entry: Record<string, unknown>): ListedPrice | undefined {
  const rows = (Array.isArray(entry.price_rows) ? entry.price_rows : []).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const r = raw as Record<string, unknown>;
    const price = usd(r.our_price);
    if (price === undefined) return [];
    const params = settings(r.quote_defaults);
    const label = str(r.model_label);
    return [
      {
        id: str(r.row_id) || "standard",
        ...(label ? { label } : {}),
        usd: price,
        ...(str(r.billing_unit) ? { unit: str(r.billing_unit) } : {}),
        ...(params ? { settings: params } : {}),
      },
    ];
  });
  if (rows.length === 0) return undefined;
  const pricing = (entry.pricing ?? {}) as Record<string, unknown>;
  const defaultUsd = usd(pricing.request);
  const params = Array.isArray(entry.pricing_params)
    ? entry.pricing_params.map(str).filter(Boolean)
    : [];
  return {
    rows,
    ...(defaultUsd !== undefined ? { default_usd: defaultUsd } : {}),
    ...(params.length ? { settings: params } : {}),
    // Atlas prices these at submit time from the full request (requires_runtime_quote).
    quoted_at_run: entry.requires_runtime_quote === true,
    source: ATLAS_PRICING_PAGE,
  };
}

/** Display strings for `multix models --live` (the `pricing` field of a listed model). */
function pricingStrings(p: ListedPrice): Record<string, string> {
  const prices = p.rows.map((r) => r.usd);
  const unit = p.rows[0]?.unit;
  return {
    ...(p.default_usd !== undefined ? { default_usd: String(p.default_usd) } : {}),
    min_usd: String(Math.min(...prices)),
    max_usd: String(Math.max(...prices)),
    ...(unit ? { unit } : {}),
  };
}

/**
 * Atlas 3D models with their prices: the 3D ids from GET /models, priced
 * from GET /pricing/models. A 3D model the price list omits is listed without a price.
 */
export async function readAtlas3dCatalog(fetchFn: FetchFn): Promise<CatalogRead> {
  const [list, prices] = await Promise.all([
    getJson(fetchFn, ATLAS_MODELS_URL),
    getJson(fetchFn, ATLAS_PRICING_URL),
  ]);
  const listed = (list as { data?: unknown }).data;
  const priced = (prices as { data?: unknown }).data;
  if (!Array.isArray(listed)) throw new Error("Atlas Cloud model list has no data list");
  if (!Array.isArray(priced)) throw new Error("Atlas Cloud price list has no data list");
  const byId = new Map<string, Record<string, unknown>>();
  for (const p of priced as Array<Record<string, unknown>>) {
    if (p && typeof p === "object" && str(p.id)) byId.set(str(p.id), p);
  }
  const models: DiscoveredModel[] = [];
  for (const m of listed as Array<Record<string, unknown>>) {
    if (!m || typeof m !== "object") continue;
    const categories = Array.isArray(m.categories) ? m.categories : [];
    if (!ATLAS_3D_CATEGORIES.some((c) => categories.includes(c))) continue;
    const id = str(m.model);
    if (!id) continue;
    const name = str(m.displayName);
    const entry = byId.get(id);
    const price = entry ? listedPriceOf(entry) : undefined;
    models.push({
      provider: "atlas",
      model: id,
      task: "3d",
      ...(name ? { name } : {}),
      ...(price ? { price, pricing: pricingStrings(price) } : {}),
    });
  }
  return { url: ATLAS_PRICING_URL, models };
}

function unknown(model: string, at: Date, reason: string, detail: string): CostEstimate {
  return {
    status: "unknown",
    reason,
    detail,
    currency: "USD",
    provider: "atlas",
    model,
    low_usd: null,
    expected_usd: null,
    high_usd: null,
    upper_bound: "none",
    text: { characters: 0, nfc_characters: 0, utf8_bytes: 0, utf16_units: 0 },
    units: {},
    assumptions: [],
    at: at.toISOString(),
  };
}

const fmt = (n: number) => `$${Number(n.toFixed(6))}`;

/** Same setting value, ignoring case for strings ("Normal" = "normal"). */
function sameSetting(a: unknown, b: Setting): boolean {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

export interface Atlas3dEstimateInput {
  /** The command being priced: "atlas 3d" or "atlas run". */
  command: string;
  model: string;
  /**
   * The request body the run sends, when the caller knows it (`atlas run --input`).
   * Absent for `atlas 3d`, which never sets a price setting, so the model's defaults apply.
   */
  input?: Record<string, unknown>;
  prices?: Atlas3dPriceSnapshot;
  at?: Date;
}

/** Price one Atlas 3D run from the cached price list. Never $0 without a price. */
export function estimateAtlas3dCost(input: Atlas3dEstimateInput): CostEstimate {
  const at = input.at ?? new Date();
  const { command, model } = input;
  if (!model) {
    return unknown(model, at, "missing_input", `Cannot price ${command} without a model id`);
  }
  const prices = input.prices;
  if (!prices) {
    return unknown(
      model,
      at,
      "no_price",
      `No Atlas Cloud 3D price list was read (the multix CLI reads it: ${REFRESH_HINT.replace(/^run /, "")})`,
    );
  }
  const fetched = Date.parse(prices.fetched_at);
  if (Number.isNaN(fetched) || at.getTime() - fetched > ATLAS_PRICE_MAX_AGE_MS) {
    return unknown(
      model,
      at,
      "stale",
      `The cached Atlas Cloud price list (fetched ${prices.fetched_at}) is too old to price a run; ${REFRESH_HINT}`,
    );
  }
  const row = prices.models.find((m) => m.model === model);
  if (!row) {
    return unknown(
      model,
      at,
      command === "atlas run" ? "unsupported" : "no_price",
      command === "atlas run"
        ? `${model} is not an Atlas Cloud 3D model; atlas run is priced for 3D models only`
        : `The Atlas Cloud price list (fetched ${prices.fetched_at}) does not list ${model} as a 3D model; ${REFRESH_HINT}`,
    );
  }
  const price = usablePrice(row.price);
  if (!price) {
    return unknown(model, at, "no_price", `Atlas Cloud lists no price for ${model}`);
  }

  const body = input.input ?? {};
  // Settings the request sets that Atlas's price may depend on.
  const named = new Set([
    ...(price.settings ?? []),
    ...price.rows.flatMap((r) => Object.keys(r.settings ?? {})),
  ]);
  const set = [...named].filter((k) => body[k] !== undefined);
  let rows = price.rows;
  let matched = true;
  const assumptions: string[] = [];
  if (prices.error) {
    assumptions.push(
      `Atlas's price list could not be refreshed (${prices.error}); priced from the copy fetched ${prices.fetched_at}.`,
    );
  }
  if (set.length > 0) {
    const narrowed = price.rows.filter((r) =>
      Object.entries(r.settings ?? {}).every(
        ([k, v]) => body[k] === undefined || typeof v === "number" || sameSetting(body[k], v),
      ),
    );
    if (narrowed.length > 0) rows = narrowed;
    else {
      matched = false;
      assumptions.push("No listed configuration matches the request's settings exactly.");
    }
  }
  const rowPrices = rows.map((r) => r.usd);
  let low = Math.min(...rowPrices);
  let high = Math.max(...rowPrices);
  let expected: number;
  if (set.length === 0 && price.default_usd !== undefined) {
    // Nothing that changes the price is set: Atlas's price for the model's defaults applies.
    low = price.default_usd;
    high = price.default_usd;
    expected = price.default_usd;
    assumptions.push(
      `${command === "atlas 3d" ? "atlas 3d sets none of the settings the price depends on" : "The input sets none of the settings the price depends on"}, so the model's default settings apply (Atlas list price ${fmt(price.default_usd)}).`,
    );
  } else {
    expected = defaultSettingsRow(price, rows, body)?.usd ?? high;
  }
  // Settings no listed row pins down (e.g. a numeric face_count) can still move the price.
  const unpinned = set.filter((k) =>
    rows.every((r) => r.settings?.[k] === undefined || typeof r.settings[k] === "number"),
  );
  if (unpinned.length > 0) {
    assumptions.push(
      `Atlas's listed rows do not pin ${unpinned.join(", ")}; the final price may differ.`,
    );
  }
  // One price for exactly these settings: no unpinned setting, no failed match.
  const exact = low === high && unpinned.length === 0 && matched;
  // A proven ceiling needs a price Atlas does not re-quote at submit time.
  const proven = exact && !price.quoted_at_run;
  if (price.quoted_at_run) {
    assumptions.push(
      "Atlas quotes the final price at submit time from the full request; this is its listed price, not a cap.",
    );
  }
  if (rows.length > 1 && low !== high) {
    assumptions.push(
      `Listed prices for these settings: ${rows.map((r) => `${r.label ?? r.id} ${fmt(r.usd)}`).join("; ")}.`,
    );
  }
  assumptions.push("One 3D model per run; Atlas does not charge failed tasks.");
  const estimate: CostEstimate = {
    status: "estimated",
    currency: "USD",
    provider: "atlas",
    model,
    low_usd: low,
    expected_usd: expected,
    high_usd: high,
    upper_bound: proven ? "proven" : "estimated",
    text: { characters: 0, nfc_characters: 0, utf8_bytes: 0, utf16_units: 0 },
    units: {},
    rate: {
      id: `atlas/${model}`,
      tier: "api",
      components: [],
      label: "Atlas Cloud list price",
      last_checked: prices.fetched_at,
      source: price.source,
    },
    assumptions,
    at: at.toISOString(),
  };
  if (exact) EXACT.add(estimate);
  return estimate;
}

/** Estimates that name one list price for exactly the request's settings. */
const EXACT = new WeakSet<CostEstimate>();

/**
 * The list price an Atlas 3D estimate pins to exactly (one configuration, no
 * unpinned or unmatched setting), else undefined: what a successful run is billed
 * at the listed price.
 */
export function exactAtlasListPrice(estimate: CostEstimate | undefined): number | undefined {
  return estimate && EXACT.has(estimate) ? (estimate.high_usd ?? undefined) : undefined;
}

/** A cached price that has the expected shape (a hand-edited cache never crashes a run). */
function usablePrice(p: ListedPrice | undefined): ListedPrice | undefined {
  if (!p || typeof p !== "object" || !Array.isArray(p.rows)) return undefined;
  const rows = p.rows.filter(
    (r) => r && typeof r === "object" && typeof r.usd === "number" && Number.isFinite(r.usd),
  );
  if (rows.length === 0) return undefined;
  return {
    ...p,
    rows,
    settings: Array.isArray(p.settings) ? p.settings.filter((s) => typeof s === "string") : [],
    default_usd:
      typeof p.default_usd === "number" && Number.isFinite(p.default_usd)
        ? p.default_usd
        : undefined,
  };
}

/**
 * Among `rows`, the one whose settings the request leaves at the model's
 * defaults (the settings of the row priced at the default price).
 */
function defaultSettingsRow(
  price: ListedPrice,
  rows: ListedPrice["rows"],
  body: Record<string, unknown>,
): ListedPrice["rows"][number] | undefined {
  if (rows.length === 1) return rows[0];
  const base = price.rows.find((r) => r.usd === price.default_usd);
  if (!base?.settings) return undefined;
  const defaults = base.settings;
  return rows.find((r) =>
    Object.entries(r.settings ?? {}).every(
      ([k, v]) => body[k] !== undefined || defaults[k] === undefined || defaults[k] === v,
    ),
  );
}

/**
 * The listed prices as catalogue rate cards: one per configuration row, priced
 * per request (one model per run). `fetched_at` dates them; the catalogue
 * treats them like any other dated provider price.
 */
export function atlas3dRateCards(models: DiscoveredModel[], fetchedAt: string): RateCard[] {
  const checked = fetchedAt.slice(0, 10);
  return models.flatMap((m) => {
    const price = m.price;
    if (!price) return [];
    const family = m.model.split("/").slice(0, -1).join("/") || m.model;
    return price.rows.map((r) => ({
      id: `atlas/${m.model}${price.rows.length > 1 ? `#${r.id}` : ""}@api`,
      provider: "atlas",
      models: [m.model],
      family,
      task: "3d" as const,
      config: price.rows.length > 1 ? { variant: r.label ?? r.id } : {},
      basis: price.quoted_at_run ? ("estimated" as const) : ("list" as const),
      tier: "api-usage",
      currency: "USD" as const,
      region: "global",
      windows: [{ components: [{ meter: "requests" as const, usd: r.usd, per: 1 }] }],
      last_checked: checked,
      source: price.source,
      verified: true,
      notes: `Atlas Cloud list price per ${r.unit?.replace(/^\//, "") || "run"} (one 3D model per run), read from its live price list${price.quoted_at_run ? "; Atlas quotes the final price at submit time" : ""}.`,
    }));
  });
}
