/**
 * Pre-flight price of `sume image|video` from the model's catalog row
 * (runtime-neutral, no network, no disk). The CLI reads the cached public
 * catalog and passes the row in; a caller without one (the MCP Worker) gets
 * "unknown", never $0.
 *
 * Price = the matching pricing option (resolution, quality, audio) × units
 * (images, or seconds of video). Billing rounds the charge up to the cent.
 * - One matching option and known units: a proven ceiling.
 * - Several matching options, or a duration the request leaves open: a
 *   min..max range whose high end is only an estimate.
 */

import type { CostEstimate } from "../../budget/cost-estimate.js";
import { ValidationError } from "../../core/errors.js";
import { SUME_CATALOG_URL, formatUsdMicros } from "./models.js";
import { type SumeCommandKind, flagsFromOptions, planSumeRequest } from "./request-plan.js";
import type { SumeModel, SumePriceOption } from "./types.js";

/** Catalog prices older than this are not used for a pre-flight price. */
export const SUME_PRICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const REFRESH_HINT = "run `multix sume models --refresh`";

/** What the caller knows about the cached catalog when pricing a run. */
export interface SumeCatalogSnapshot {
  /** When the catalog was fetched (ISO 8601). */
  fetched_at: string;
  /** The catalog URL it was read from (the rate source). */
  source: string;
  /** The row of the requested model; absent when the catalog does not list it. */
  model?: SumeModel;
}

export interface SumeEstimateInput {
  command: SumeCommandKind;
  /** The model id the run will use (flag or env default); empty when there is none. */
  model: string;
  options: Record<string, unknown>;
  catalog?: SumeCatalogSnapshot;
  at?: Date;
}

function unknown(input: SumeEstimateInput, at: Date, reason: string, detail: string): CostEstimate {
  return {
    status: "unknown",
    reason,
    detail,
    currency: "USD",
    provider: "sume",
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

/** The value a field takes: the flag's, else the row's schema default. */
function effective<T>(
  flag: T | undefined,
  fallback: unknown,
  guard: (v: unknown) => v is T,
): T | undefined {
  if (flag !== undefined) return flag;
  return guard(fallback) ? fallback : undefined;
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isPositive = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;

/** Pricing options the request can be billed at (an option without a dimension matches any value). */
function matchingOptions(model: SumeModel, body: Record<string, unknown>): SumePriceOption[] {
  const rf = model.request_fields ?? {};
  const resolution = effective(
    isString(body.resolution) ? body.resolution : undefined,
    rf.resolution?.default,
    isString,
  );
  const quality = effective(
    isString(body.quality) ? body.quality : undefined,
    rf.quality?.default,
    isString,
  );
  const audio = effective(
    isBool(body.generate_audio) ? body.generate_audio : undefined,
    rf.generate_audio?.default,
    isBool,
  );
  return (model.pricing?.options ?? []).filter(
    (o) =>
      (o.resolution === undefined || resolution === undefined || o.resolution === resolution) &&
      (o.quality === undefined || quality === undefined || o.quality === quality) &&
      (o.audio === undefined || audio === undefined || o.audio === audio),
  );
}

/** Units billed: a known count, or a range the request leaves open. */
function billedUnits(
  model: SumeModel,
  command: SumeCommandKind,
  body: Record<string, unknown>,
): { low: number; high: number; label: string } | string {
  const rf = model.request_fields ?? {};
  if (command === "image") {
    const n =
      effective(
        isPositive(body.num_images) ? body.num_images : undefined,
        rf.num_images?.default,
        isPositive,
      ) ?? 1;
    return { low: n, high: n, label: `${n} image${n === 1 ? "" : "s"}` };
  }
  const known = effective(
    isPositive(body.duration) ? body.duration : undefined,
    rf.duration?.default,
    isPositive,
  );
  if (known !== undefined) return { low: known, high: known, label: `${known}s` };
  const c = model.capabilities;
  const values = c.duration_values;
  if (values && values.length > 0) {
    const low = Math.min(...values);
    const high = Math.max(...values);
    return { low, high, label: `${low}-${high}s (--duration not set)` };
  }
  const range = c.duration_seconds;
  if (range && range.max > 0) {
    const low = Math.max(range.min, 1);
    return { low, high: range.max, label: `${low}-${range.max}s (--duration not set)` };
  }
  return `${model.id} lists no duration range; pass --duration`;
}

/** Charge for `units` at `option`, rounded up to the cent as Sume bills it. */
function priceOf(option: SumePriceOption, units: number): number {
  return Math.ceil((option.usd_micros * units) / 10_000) / 100;
}

/** Price a `sume image|video` run from the cached catalog row. */
export function estimateSumeCost(input: SumeEstimateInput): CostEstimate {
  const at = input.at ?? new Date();
  const command = `sume ${input.command}`;
  const catalog = input.catalog;
  if (!catalog) {
    return unknown(
      input,
      at,
      "no_price",
      `No cached Sume catalog to price ${command}; ${REFRESH_HINT}`,
    );
  }
  const fetched = Date.parse(catalog.fetched_at);
  if (Number.isNaN(fetched) || at.getTime() - fetched > SUME_PRICE_MAX_AGE_MS) {
    return unknown(
      input,
      at,
      "stale",
      `The cached Sume catalog (fetched ${catalog.fetched_at}) is older than 24h; ${REFRESH_HINT}`,
    );
  }
  if (!input.model) {
    return unknown(
      input,
      at,
      "missing_input",
      `Cannot price ${command} without --model (or SUME_${input.command.toUpperCase()}_MODEL)`,
    );
  }
  const model = catalog.model;
  if (!model || model.id !== input.model) {
    return unknown(
      input,
      at,
      "no_price",
      `The cached Sume catalog does not list ${input.model}; ${REFRESH_HINT}`,
    );
  }
  let body: Record<string, unknown>;
  try {
    body = planSumeRequest({
      command: input.command,
      model,
      flags: flagsFromOptions(input.options),
      checkPrompt: false,
    }).body;
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return unknown(input, at, "missing_input", `Cannot price ${command}: ${error.message}`);
  }
  const options = matchingOptions(model, body);
  if (!model.pricing || options.length === 0) {
    return unknown(
      input,
      at,
      "no_price",
      `The Sume catalog lists no price for ${model.id} with these settings; ${REFRESH_HINT}`,
    );
  }
  const units = billedUnits(model, input.command, body);
  if (typeof units === "string") {
    return unknown(input, at, "missing_input", `Cannot price ${command}: ${units}`);
  }
  const prices = options.flatMap((o) => [priceOf(o, units.low), priceOf(o, units.high)]);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const proven = options.length === 1 && units.low === units.high;
  const unit = model.pricing.unit;
  return {
    status: "estimated",
    currency: "USD",
    provider: "sume",
    model: model.id,
    low_usd: low,
    // The expected cost is the high end: a run is charged what it reserves until Sume settles it.
    expected_usd: high,
    high_usd: high,
    upper_bound: proven ? "proven" : "estimated",
    text: { characters: 0, nfc_characters: 0, utf8_bytes: 0, utf16_units: 0 },
    units: {},
    rate: {
      id: `sume/${model.id}`,
      tier: "api",
      components: [],
      label: "Sume API list price",
      last_checked: catalog.fetched_at,
      source: catalog.source || SUME_CATALOG_URL,
    },
    assumptions: [
      `Billed units: ${units.label}.`,
      `Price per ${unit}: ${options.map((o) => `${o.label || "default"} ${formatUsdMicros(o.usd_micros)}`).join("; ")}.`,
      ...(options.length > 1
        ? [
            "Several price options match these settings (set --resolution, --quality or --generate-audio to narrow them).",
          ]
        : []),
      "Sume reserves the charge at submit, rounded up to the cent, and refunds failed or canceled jobs.",
    ],
    at: at.toISOString(),
  };
}
