/**
 * Sume prices as `multix.cost/v1` estimates (runtime-neutral).
 *
 * - `estimateFromQuote`: the answer of POST /v1/open/estimate, which Sume
 *   documents as "the exact dollars for that input"; a charge is rounded up
 *   to the cent, so the cap is the quote rounded up to the cent.
 * - `estimateFromCatalog`: the catalog's list price per image or per second
 *   times the units the request asks for. Prices are "from" prices and some
 *   models bill in steps or minimums (see `constraints`), so the high end is
 *   an estimate, never a proven cap.
 */

import { type CostEstimate, countText } from "../../budget/cost-estimate.js";
import type { PriceMeter } from "../../budget/pricing-catalog.js";
import { SUME_PROVIDER } from "./models.js";
import type { SumeCatalogModel, SumeEstimate, SumePriceOption } from "./types.js";

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const ceilCent = (usd: number) => Math.ceil(Math.round(usd * 1e6) / 1e4) / 100;

function base(
  model: string,
  at: Date,
): Omit<CostEstimate, "status" | "low_usd" | "expected_usd" | "high_usd" | "upper_bound"> {
  return {
    currency: "USD",
    provider: SUME_PROVIDER,
    model,
    text: countText(""),
    units: {},
    assumptions: [],
    at: at.toISOString(),
  };
}

export function unknownSumeEstimate(
  model: string,
  reason: string,
  detail: string,
  at = new Date(),
): CostEstimate {
  return {
    ...base(model, at),
    status: "unknown",
    reason,
    detail,
    low_usd: null,
    expected_usd: null,
    high_usd: null,
    upper_bound: "none",
  };
}

export function estimateFromQuote(
  model: string,
  quote: SumeEstimate,
  opts: { source: string; at?: Date; notes?: string[] },
): CostEstimate {
  const at = opts.at ?? new Date();
  const usd = round6(quote.usd_micros / 1e6);
  const meter: PriceMeter | undefined =
    quote.billing?.duration_seconds != null ? "output_video_seconds" : undefined;
  const seconds = quote.billing?.duration_seconds ?? undefined;
  return {
    ...base(model, at),
    status: "estimated",
    low_usd: usd,
    expected_usd: usd,
    high_usd: ceilCent(usd),
    upper_bound: "proven",
    units:
      meter && seconds !== undefined
        ? { [meter]: { low: seconds, expected: seconds, high: seconds } }
        : {},
    rate: {
      id: `sume:${model}:quote`,
      tier: quote.billing?.resolution ?? "quote",
      components: [],
      label: `Sume estimate${quote.billing?.unit ? ` (${quote.billing.unit})` : ""}`,
      last_checked: at.toISOString(),
      source: opts.source,
    },
    assumptions: [
      "Priced by Sume's non-billable estimate endpoint for this exact input; the charge is rounded up to the cent.",
      ...(opts.notes ?? []),
    ],
  };
}

function optionMicros(o: SumePriceOption): number | undefined {
  if (typeof o.usd_micros === "number" && Number.isFinite(o.usd_micros) && o.usd_micros >= 0) {
    return o.usd_micros;
  }
  const n = Number(o.usd);
  return o.usd !== undefined && Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6) : undefined;
}

/** Price rows that can apply to the body: an attribute the body leaves open matches any row. */
function matchingOptions(model: SumeCatalogModel, body: Record<string, unknown>): number[] {
  const options = model.pricing?.options ?? [];
  const fits = (want: unknown, have: unknown) =>
    want === undefined || have === undefined || want === have;
  return options
    .filter(
      (o) =>
        fits(body.resolution, o.resolution) &&
        fits(body.quality, o.quality) &&
        fits(body.generate_audio, o.audio),
    )
    .map(optionMicros)
    .filter((n): n is number => n !== undefined);
}

/** Billed units the body asks for, as a range when the model picks a default. */
function unitRange(
  model: SumeCatalogModel,
  body: Record<string, unknown>,
): { meter: PriceMeter; low: number; high: number; note?: string } | undefined {
  const unit = model.pricing?.unit;
  if (unit === "image") {
    const n = typeof body.num_images === "number" ? body.num_images : undefined;
    return n !== undefined
      ? { meter: "output_images", low: n, high: n }
      : {
          meter: "output_images",
          low: 1,
          high: 1,
          note: "Assumes one image (the model's default count).",
        };
  }
  if (unit === "second") {
    const d = typeof body.duration === "number" ? body.duration : undefined;
    if (d !== undefined) return { meter: "output_video_seconds", low: d, high: d };
    const c = model.capabilities ?? {};
    const values = Array.isArray(c.duration_values) ? c.duration_values : [];
    const min = values.length ? Math.min(...values) : c.duration_seconds?.min;
    const max = values.length ? Math.max(...values) : c.duration_seconds?.max;
    if (min === undefined || max === undefined) return undefined;
    return {
      meter: "output_video_seconds",
      low: min,
      high: max,
      note: `No --duration: the model picks the length, priced over its ${min}-${max} s range.`,
    };
  }
  return undefined;
}

export function estimateFromCatalog(
  model: SumeCatalogModel,
  body: Record<string, unknown>,
  opts: { source: string; fetchedAt: string; at?: Date; notes?: string[] },
): CostEstimate {
  const at = opts.at ?? new Date();
  const prices = matchingOptions(model, body);
  const units = unitRange(model, body);
  if (prices.length === 0 || !units) {
    return unknownSumeEstimate(
      model.id,
      "no_price",
      `The Sume catalog lists no ${units ? "price row for these options" : `billing unit for "${model.pricing?.unit ?? "?"}"`} of ${model.id}.`,
      at,
    );
  }
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const billingNotes = (model.constraints ?? []).filter((c) => /bill/i.test(c));
  return {
    ...base(model.id, at),
    status: "estimated",
    low_usd: round6((low * units.low) / 1e6),
    expected_usd: round6((high * units.high) / 1e6),
    high_usd: round6((high * units.high) / 1e6),
    upper_bound: "estimated",
    units: { [units.meter]: { low: units.low, expected: units.high, high: units.high } },
    rate: {
      id: `sume:${model.id}`,
      tier: "list",
      components: [{ meter: units.meter, usd: round6(high / 1e6), per: 1 }],
      label: `catalog list price per ${model.pricing?.unit}`,
      last_checked: opts.fetchedAt,
      source: opts.source,
    },
    assumptions: [
      "Catalog list price; Sume prices the exact input with POST /v1/open/estimate (set SUME_API_KEY for a proven cap).",
      ...(units.note ? [units.note] : []),
      ...billingNotes.map((c) => `Catalog: ${c}`),
      ...(opts.notes ?? []),
    ],
  };
}
