/**
 * Live price quotes from a provider's own estimate endpoint, for commands
 * whose price depends on more than the catalog in pricing-catalog.ts can
 * hold (Sume routes dozens of vendors' models, each with its own rate card).
 * Runtime-neutral: the caller passes `fetch`, so the CLI pre-flight and the
 * MCP Worker answer the same way.
 *
 * A quote that cannot be made is an "unknown" estimate (never $0), so
 * `--max-cost` refuses instead of promising a cap it cannot back.
 */

import type { FetchLike } from "../core/fetch-json.js";
import { estimateSume } from "../providers/sume/estimate.js";
import { SUME_ESTIMATE_URL } from "../providers/sume/models.js";
import {
  type SumeRouter,
  buildSumeBody,
  estimateInput,
  mediaInputs,
  readOption,
} from "../providers/sume/request.js";
import type { SumeEstimate } from "../providers/sume/types.js";
import type { CostEstimate } from "./cost-estimate.js";

type Options = Record<string, unknown>;

export interface QuoteContext {
  /** Must not be a fetch that records billable calls: the quote is free and sends no key. */
  fetch: FetchLike;
  at?: Date;
}

const SUME_ROUTERS: Record<string, SumeRouter> = {
  "sume image": "image",
  "sume video": "video",
};

/** Commands priced by a live provider quote instead of the static catalog. */
export function quotedCommands(): string[] {
  return Object.keys(SUME_ROUTERS);
}

const NO_TEXT = { characters: 0, nfc_characters: 0, utf8_bytes: 0, utf16_units: 0 };

function unknownQuote(
  provider: string,
  model: string,
  reason: string,
  detail: string,
  at: Date,
): CostEstimate {
  return {
    status: "unknown",
    reason,
    detail,
    currency: "USD",
    provider,
    model,
    low_usd: null,
    expected_usd: null,
    high_usd: null,
    upper_bound: "none",
    text: { ...NO_TEXT },
    units: {},
    assumptions: [],
    at: at.toISOString(),
  };
}

function sumeEstimate(quote: SumeEstimate, model: string, at: Date): CostEstimate {
  const usd = Number(quote.usd);
  const b = quote.billing;
  const assumptions: string[] = [];
  if (b?.unit) {
    const quantity = b.quantity !== undefined ? `${b.quantity} × ` : "";
    const details = [
      b.duration_seconds != null ? `${b.duration_seconds} s` : undefined,
      b.resolution ? b.resolution : undefined,
    ].filter(Boolean);
    assumptions.push(
      `Billed as ${quantity}${b.unit}${details.length > 0 ? ` (${details.join(", ")})` : ""}.`,
    );
  }
  assumptions.push(
    "Parameters left unset are priced at the model's default (for example its default quality, resolution or duration).",
    "Sume reserves this price at submit and refunds failed or canceled jobs; the charge is the submit response's usage.usd, which can sit a cent below the quote.",
  );
  return {
    status: "estimated",
    currency: "USD",
    provider: "sume",
    model,
    low_usd: usd,
    expected_usd: usd,
    high_usd: usd,
    upper_bound: "proven",
    text: { ...NO_TEXT },
    units: {},
    rate: {
      id: `sume/${model}@quote`,
      tier: "list",
      components: [],
      label: "live quote",
      last_checked: at.toISOString(),
      source: SUME_ESTIMATE_URL,
    },
    assumptions,
    at: at.toISOString(),
  };
}

async function quoteSume(
  router: SumeRouter,
  options: Options,
  ctx: QuoteContext,
  at: Date,
): Promise<CostEstimate> {
  const rawModel = readOption(options, "model");
  const model = typeof rawModel === "string" ? rawModel.trim() : "";
  if (!model) {
    return unknownQuote("sume", "", "missing_input", "Cannot quote without -m/--model", at);
  }
  try {
    const local = mediaInputs(router, options).flatMap((m) =>
      m.values.filter((v) => !/^https:\/\//i.test(v)).map(() => m.flag),
    );
    if (local.length > 0) {
      return unknownQuote(
        "sume",
        model,
        "missing_input",
        `Cannot quote a local file (${[...new Set(local)].join(", ")}) before it is uploaded; upload it with \`multix sume upload <file>\` and pass the printed https URL instead`,
        at,
      );
    }
    // The prompt does not change the price, so it is never sent to the quote.
    const body = buildSumeBody(router, options);
    return sumeEstimate(await estimateSume(ctx.fetch, model, estimateInput(body)), model, at);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unknownQuote("sume", model, "quote_failed", `Sume price quote failed: ${message}`, at);
  }
}

/**
 * Quote `command` from its options (camelCase or kebab-case keys). Returns
 * undefined for commands without a live quote; otherwise an estimate whose
 * single amount is the provider's quote, or an "unknown" one when the quote
 * could not be made.
 */
export async function quoteCommand(
  command: string,
  options: Options,
  ctx: QuoteContext,
): Promise<CostEstimate | undefined> {
  const router = SUME_ROUTERS[command];
  if (!router) return undefined;
  return quoteSume(router, options, ctx, ctx.at ?? new Date());
}
