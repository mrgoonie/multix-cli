/**
 * Atlas Cloud 3D prices (runtime-neutral: the caller passes fetch).
 *
 * The `price.actual.base_price` of the public model list
 * (GET /api/v1/models) is not what a 3D run costs: Atlas bills 3D models per
 * request at the price its pricing service quotes for the request's settings
 * (Meshy v7 Image-to-3D: base_price 0.02, billed $0.44-$0.88; Hi3D v3.0
 * master: base_price 0.017, billed $5.185). multix reads the 3D models from
 * the model list (its IMAGE-TO-3D / TEXT-TO-3D categories) and their prices
 * from the two public pricing endpoints the pricing page uses:
 *
 * - GET  /api/v1/pricing/models     per-configuration price rows ("our_price")
 * - POST /api/v1/pricing/calculate  `{model, ...settings}` -> the exact price
 *
 * Neither needs a key. A quote sends the model id and the request's pricing
 * settings only (never the prompt, images or key).
 */

import type { DiscoveredModel } from "../../capabilities/capability-types.js";
import type { CatalogRead, FetchFn } from "../../capabilities/model-discovery.js";
import { DEFAULT_ATLAS_BASE_URL } from "./models.js";

export const ATLAS_PRICING_PAGE = "https://www.atlascloud.ai/pricing/models";
export const ATLAS_MODELS_PATH = "/models";
export const ATLAS_PRICING_PATH = "/pricing/models";
export const ATLAS_QUOTE_PATH = "/pricing/calculate";

/** Categories of the model list that mark a 3D model. */
const THREE_D_CATEGORIES = new Set(["IMAGE-TO-3D", "TEXT-TO-3D"]);

const TIMEOUT_MS = 15_000;
/** The quote runs before every priced 3D run; a slow pricing service must not hold it up long. */
export const ATLAS_QUOTE_TIMEOUT_MS = 10_000;

/** One configuration's price, as the pricing list states it. */
export interface AtlasPriceRow {
  label: string;
  usd: number;
  /** Atlas's billing unit text ("/pic", "/generation"): one completed 3D request. */
  unit: string;
}

/** A 3D model with its listed prices (as kept in the `models --live` cache). */
export interface Atlas3dModel extends DiscoveredModel {
  price_rows?: AtlasPriceRow[];
  /** Request fields that change the price (`pricing_params`); absent when none do. */
  pricing_params?: string[];
}

/** Non-empty text with control characters removed (it reaches terminals). */
function str(v: unknown, max = 200): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim() : "";
  return s ? s.slice(0, max) : undefined;
}

/** A finite, non-negative USD amount from a number or a decimal string. */
function usdOf(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 && n < 10_000 ? n : undefined;
}

const PARAM_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** Price rows and pricing fields of one row of the pricing list (or of a cached model). */
export function parsePriceFields(
  row: unknown,
): Pick<Atlas3dModel, "price_rows" | "pricing_params"> {
  const r = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
  const rows = (Array.isArray(r.price_rows) ? r.price_rows : [])
    .slice(0, 64)
    .flatMap((p): AtlasPriceRow[] => {
      const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
      // The cache stores `usd`; the pricing list `our_price` (Atlas's price after its discount).
      const usd = usdOf(o.usd ?? o.our_price);
      if (usd === undefined) return [];
      return [
        {
          label: str(o.label ?? o.model_label) ?? "default",
          usd,
          unit: str(o.unit ?? o.billing_unit, 20) ?? "",
        },
      ];
    });
  const params = (Array.isArray(r.pricing_params) ? r.pricing_params : [])
    .filter((p): p is string => typeof p === "string" && PARAM_NAME.test(p))
    .slice(0, 32);
  return {
    ...(rows.length ? { price_rows: rows } : {}),
    ...(params.length ? { pricing_params: params } : {}),
  };
}

/** Lowest and highest listed price, as a `models --live` pricing record (USD strings). */
function pricingRecord(rows: AtlasPriceRow[] | undefined): Record<string, string> | undefined {
  if (!rows?.length) return undefined;
  const prices = rows.map((r) => r.usd);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  return low === high
    ? { usd_per_request: String(low) }
    : { usd_per_request_min: String(low), usd_per_request_max: String(high) };
}

/** A cached 3D model re-parsed, so an edited cache file cannot smuggle odd values in. */
export function parseAtlas3dModel(raw: unknown): Atlas3dModel | undefined {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const model = str(r.model);
  if (!model || r.provider !== "atlas") return undefined;
  const name = str(r.name);
  const fields = parsePriceFields(r);
  const pricing = pricingRecord(fields.price_rows);
  return {
    provider: "atlas",
    model,
    task: "3d",
    ...(name ? { name } : {}),
    ...(pricing ? { pricing } : {}),
    ...fields,
  };
}

async function getJson(fetchFn: FetchFn, url: string): Promise<unknown> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return (await res.json()) as unknown;
}

function dataList(body: unknown, what: string): unknown[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error(`Atlas Cloud ${what} response has no data list`);
  return data;
}

/**
 * The Atlas 3D models with their listed prices. Reads the model list (which
 * models are 3D, their names) and the pricing list. Throws on network, HTTP
 * or shape errors; a 3D model the pricing list does not price is kept, unpriced.
 */
export async function readAtlas3dCatalog(
  fetchFn: FetchFn,
  baseUrl: string = DEFAULT_ATLAS_BASE_URL,
): Promise<CatalogRead> {
  const base = baseUrl.replace(/\/+$/, "");
  const [list, pricing] = await Promise.all([
    getJson(fetchFn, `${base}${ATLAS_MODELS_PATH}`),
    getJson(fetchFn, `${base}${ATLAS_PRICING_PATH}`),
  ]);
  const prices = new Map<string, unknown>();
  for (const row of dataList(pricing, "pricing list")) {
    const id = str((row as { id?: unknown } | null)?.id);
    if (id) prices.set(id, row);
  }
  const models: Atlas3dModel[] = [];
  const seen = new Set<string>();
  for (const row of dataList(list, "model list")) {
    const r = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
    const categories = Array.isArray(r.categories) ? r.categories : [];
    if (!categories.some((c) => typeof c === "string" && THREE_D_CATEGORIES.has(c))) continue;
    if (r.display_console === false) continue;
    const model = str(r.model);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const parsed = parseAtlas3dModel({
      provider: "atlas",
      model,
      name: r.displayName,
      ...parsePriceFields(prices.get(model)),
    });
    if (parsed) models.push(parsed);
  }
  return { url: `${base}${ATLAS_PRICING_PATH}`, models };
}

/** Atlas's price for one request with the given settings. */
export interface AtlasQuote {
  usd: number;
  /** Atlas marks a price it cannot fix before the run (token-billed models) as estimated. */
  estimated: boolean;
  price_version?: string;
}

/** The quote in a /pricing/calculate response; throws when it has none. */
export function parseAtlasQuote(body: unknown): AtlasQuote {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const data = (b.data && typeof b.data === "object" ? b.data : undefined) as
    | Record<string, unknown>
    | undefined;
  const usd = usdOf(data?.price);
  if (Number(b.code) !== 200 || !data || usd === undefined) {
    throw new Error(`Atlas Cloud returned no price${str(b.msg) ? ` (${str(b.msg)})` : ""}`);
  }
  const version = str(data.price_version, 100);
  return {
    usd,
    estimated: data.estimated !== false,
    ...(version ? { price_version: version } : {}),
  };
}

/**
 * Ask Atlas's pricing service what one request costs. `settings` should hold
 * only the request's pricing fields (see `pricingSettings`).
 */
export async function quoteAtlasPrice(opts: {
  fetchFn: FetchFn;
  model: string;
  settings?: Record<string, unknown>;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<AtlasQuote> {
  const base = (opts.baseUrl ?? DEFAULT_ATLAS_BASE_URL).replace(/\/+$/, "");
  const res = await opts.fetchFn(`${base}${ATLAS_QUOTE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ...opts.settings, model: opts.model }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? ATLAS_QUOTE_TIMEOUT_MS),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status} from the Atlas Cloud pricing service`);
  }
  return parseAtlasQuote(body);
}

/** The request's values for the fields that change the price; nothing else is sent to a quote. */
export function pricingSettings(
  input: Record<string, unknown>,
  params: readonly string[] | undefined,
): Record<string, unknown> {
  return Object.fromEntries((params ?? []).filter((p) => p in input).map((p) => [p, input[p]]));
}
