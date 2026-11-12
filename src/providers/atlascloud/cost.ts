/**
 * Pre-flight price of an Atlas Cloud 3D run (`atlas 3d`, `atlas run <3d model>`),
 * runtime-neutral and without network: the CLI reads the cached 3D price list
 * and asks Atlas's pricing service for the request's quote, then passes both
 * in. A caller without them (the MCP Worker) gets "unknown", never $0.
 *
 * Atlas fixes a 3D price per request before the run (Meshy, Hunyuan, Tripo,
 * Hi3D, Seed3D bill one completed request at the quoted price; failed tasks
 * are not charged), so a quote Atlas does not mark as estimated is a proven
 * ceiling, and it is also the cost of a completed run.
 */

import type { CostEstimate } from "../../budget/cost-estimate.js";
import { ATLAS_PRICING_PAGE, type Atlas3dModel, type AtlasQuote } from "./pricing.js";

/** Listed prices older than this are not used to decide what a run is priced at. */
export const ATLAS_PRICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const REFRESH_HINT = "run `multix models --task 3d --live --refresh`";

/** What the caller learned about a 3D run's price before it starts. */
export interface AtlasPriceSnapshot {
  /** When the 3D price list was fetched (ISO 8601); absent when there is none. */
  fetched_at?: string;
  /** The listing of the model; absent when the 3D list does not have it. */
  model?: Atlas3dModel;
  /** Atlas's quote for this request's settings. */
  quote?: AtlasQuote;
  /** Why there is no list or no quote (network or service error). */
  error?: string;
  /** Pricing fields multix sent with the quote. */
  settings?: Record<string, unknown>;
}

export interface AtlasEstimateInput {
  command: string;
  model: string;
  snapshot?: AtlasPriceSnapshot;
  at?: Date;
}

function unknown(
  input: AtlasEstimateInput,
  at: Date,
  reason: string,
  detail: string,
): CostEstimate {
  return {
    status: "unknown",
    reason,
    detail,
    currency: "USD",
    provider: "atlas",
    model: input.model,
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

const short = (n: number) => `$${Number(n.toPrecision(6))}`;

/** Price an Atlas 3D run from the cached list and the request's quote. */
export function estimateAtlasCost(input: AtlasEstimateInput): CostEstimate {
  const at = input.at ?? new Date();
  const { command } = input;
  const snap = input.snapshot;
  if (!input.model) {
    return unknown(input, at, "missing_input", `Cannot price ${command} without a model id`);
  }
  if (!snap?.fetched_at) {
    return unknown(
      input,
      at,
      "no_price",
      `No Atlas Cloud 3D price list to price ${command}${snap?.error ? ` (${snap.error})` : ""}; ${REFRESH_HINT}`,
    );
  }
  const fetched = Date.parse(snap.fetched_at);
  if (Number.isNaN(fetched) || at.getTime() - fetched > ATLAS_PRICE_MAX_AGE_MS) {
    return unknown(
      input,
      at,
      "stale",
      `The cached Atlas Cloud 3D price list (fetched ${snap.fetched_at}) is older than 24h; ${REFRESH_HINT}`,
    );
  }
  const listed = snap.model;
  if (!listed || listed.model !== input.model) {
    return unknown(
      input,
      at,
      command === "atlas run" ? "unsupported" : "no_price",
      command === "atlas run"
        ? `${input.model} is not an Atlas Cloud 3D model; multix prices atlas run for 3D models only`
        : `The Atlas Cloud 3D list does not include ${input.model}; ${REFRESH_HINT}`,
    );
  }
  const quote = snap.quote;
  if (!quote) {
    return unknown(
      input,
      at,
      "no_price",
      `Atlas Cloud's pricing service gave no price for ${input.model}${snap.error ? ` (${snap.error})` : ""}`,
    );
  }
  const settings = Object.entries(snap.settings ?? {});
  const listedPrices = (listed.price_rows ?? []).map((r) => `${r.label} ${short(r.usd)}`);
  return {
    status: "estimated",
    currency: "USD",
    provider: "atlas",
    model: input.model,
    low_usd: quote.usd,
    expected_usd: quote.usd,
    high_usd: quote.usd,
    upper_bound: quote.estimated ? "estimated" : "proven",
    text: { characters: 0, nfc_characters: 0, utf8_bytes: 0, utf16_units: 0 },
    units: { requests: { low: 1, expected: 1, high: 1 } },
    rate: {
      id: `atlas/${input.model}@quote`,
      tier: "api",
      components: [{ meter: "requests", usd: quote.usd, per: 1 }],
      label: "Atlas Cloud price quote",
      last_checked: at.toISOString(),
      source: ATLAS_PRICING_PAGE,
      ...(quote.price_version ? { notes: `price_version ${quote.price_version}` } : {}),
    },
    assumptions: [
      `Atlas Cloud quoted ${short(quote.usd)} per request for ${settings.length ? settings.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ") : "the model's default settings"}${quote.estimated ? "; Atlas marks it as an estimate" : ""}.`,
      ...(listedPrices.length > 1
        ? [`Listed prices by setting: ${listedPrices.slice(0, 8).join("; ")}.`]
        : []),
      "The quote came from Atlas's public pricing service; only the model id and its pricing settings were sent, without a key, prompt or files.",
      "Atlas bills a 3D request once it completes; failed tasks are not charged.",
    ],
    at: at.toISOString(),
  };
}
