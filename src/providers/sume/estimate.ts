/**
 * Sume's public price quote, `POST /v1/open/estimate` with `{model, input}`.
 * It needs no key and charges nothing, so the pre-flight cost check can call
 * it before any paid request. Runtime-neutral: the caller passes fetch.
 *
 * The quote is not a validator: it ignores unknown fields and prices unset
 * parameters at the model's default.
 */

import { ProviderError } from "../../core/errors.js";
import { type FetchLike, fetchJson } from "../../core/fetch-json.js";
import { mapSumeError } from "./errors.js";
import { SUME_ESTIMATE_URL, parseUsd } from "./models.js";
import type { SumeEstimate } from "./types.js";

const TIMEOUT_MS = 15_000;

function record(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Validate an estimate response body. Throws ProviderError when it is not one. */
export function parseSumeEstimate(body: unknown): SumeEstimate {
  const data = record(record(body)?.data);
  const usd = data?.usd;
  if (!data || parseUsd(usd) === undefined || typeof data.model !== "string") {
    throw new ProviderError("Malformed Sume estimate response: missing data.usd", "sume");
  }
  const currency = typeof data.currency === "string" ? data.currency : "USD";
  if (currency !== "USD") {
    throw new ProviderError(`Sume estimate is in ${currency}, expected USD`, "sume");
  }
  const out: SumeEstimate = { model: data.model, currency, usd: usd as string };
  if (typeof data.usd_micros === "number") out.usd_micros = data.usd_micros;
  if (typeof data.route === "string") out.route = data.route;
  const billing = record(data.billing);
  if (billing) {
    out.billing = {};
    if (typeof billing.unit === "string") out.billing.unit = billing.unit;
    if (typeof billing.quantity === "number") out.billing.quantity = billing.quantity;
    if (typeof billing.duration_seconds === "number")
      out.billing.duration_seconds = billing.duration_seconds;
    if (typeof billing.resolution === "string") out.billing.resolution = billing.resolution;
  }
  return out;
}

/**
 * Quote one request. `input` holds the generate body without `model`.
 * Throws SumeApiError (HTTP), ProviderError (shape) or a fetch error.
 */
export async function estimateSume(
  fetchFn: FetchLike,
  model: string,
  input: Record<string, unknown>,
  url: string = SUME_ESTIMATE_URL,
): Promise<SumeEstimate> {
  try {
    const body = await fetchJson<unknown>({
      url,
      method: "POST",
      headers: { accept: "application/json" },
      body: { model, input },
      timeoutMs: TIMEOUT_MS,
      fetch: fetchFn,
    });
    return parseSumeEstimate(body);
  } catch (error) {
    throw mapSumeError(error, `model ${model}`);
  }
}
