/**
 * Pre-flight price of `toapis image|video` (runtime-neutral, no network).
 *
 * Rates are ToAPIs' own list prices, read from its public quote endpoint
 * (the one behind https://toapis.com/pricing) on TOAPIS_PRICES_CHECKED. A model
 * not listed here is "unknown", never $0; ToAPIs settles the real charge in
 * `billing.cost_usd`, which the run's receipt records.
 *
 * - per_request (images, Veo reseller): price × images. Proven ceiling.
 * - per_second: price × --duration. Proven ceiling.
 * - per_token (Seedance 2.x): tokens = width × height × (24 × seconds + 1) / 1024
 *   at the 16:9 frame size, matching a live 480p 4 s run (40,594 tokens).
 *   Other aspect ratios have about the same pixel count, so the high end is an
 *   estimate, not a proven cap; video input adds tokens and is not priced.
 */

import type { CostEstimate } from "../../budget/cost-estimate.js";
import { TOAPIS_PRICING_LINK, TOAPIS_PROVIDER } from "./models.js";

export const TOAPIS_PRICES_CHECKED = "2026-11-18";

type Prices = Readonly<Record<string, number>>;
interface Rate {
  charge: "per_request" | "per_second" | "per_token";
  /** USD per image/request, per second, or per 1M tokens, by resolution ("*" = any). */
  prices: Prices;
}

const any = (usd: number): Prices => ({ "*": usd });

/** USD list prices on TOAPIS_PRICES_CHECKED (default account group). */
export const TOAPIS_RATES: Readonly<Record<string, Rate>> = {
  // Seedance 2.x: USD per 1M total tokens, no video input.
  "seedance-2-5": { charge: "per_token", prices: { "480p": 10, "720p": 10, "1080p": 11 } },
  "seedance-2-5-flash": { charge: "per_token", prices: { "480p": 6.3, "720p": 6.3 } },
  "seedance-2": {
    charge: "per_token",
    prices: { "480p": 6.571429, "720p": 6.571429, "1080p": 7.285714 },
  },
  "seedance-2-fast": { charge: "per_token", prices: { "480p": 4.141791, "720p": 4.141791 } },
  "seedance-2-mini": { charge: "per_token", prices: { "480p": 1.88806, "720p": 1.88806 } },
  // Video billed per output second.
  "doubao-seedance-1-5-pro": {
    charge: "per_second",
    prices: { "480p": 0.0204, "720p": 0.044, "1080p": 0.108 },
  },
  "grok-video-1.5": { charge: "per_second", prices: { "480p": 0.0102, "720p": 0.0191 } },
  "wan3.0-video": {
    charge: "per_second",
    prices: { "480p": 0.0329, "720p": 0.0658, "1080p": 0.1315 },
  },
  "wan2.6": { charge: "per_second", prices: { "720p": 0.06, "1080p": 0.1 } },
  "happyhorse-1.1": { charge: "per_second", prices: { "720p": 0.0643, "1080p": 0.0857 } },
  "kling-v2-6": { charge: "per_second", prices: any(0.0322) },
  "Veo3.1-lite-official": { charge: "per_second", prices: { "720p": 0.024, "1080p": 0.04 } },
  "Veo3.1-fast-official": { charge: "per_second", prices: { "720p": 0.08, "1080p": 0.096 } },
  // One 8 s video per request.
  "veo3.1-lite": { charge: "per_request", prices: any(0.07) },
  "veo3.1-fast": { charge: "per_request", prices: any(0.14) },
  // Images, per image.
  "gpt-image-2": { charge: "per_request", prices: { "1K": 0.015, "2K": 0.02, "4K": 0.025 } },
  "gemini-3-pro-image-preview": {
    charge: "per_request",
    prices: { "1K": 0.04, "2K": 0.05, "4K": 0.06 },
  },
  "gemini-3.1-flash-image-preview": {
    charge: "per_request",
    prices: { "1K": 0.025, "2K": 0.03, "4K": 0.04 },
  },
  "gemini-2.5-flash-image-preview": { charge: "per_request", prices: any(0.012) },
  "doubao-seedream-5-5": { charge: "per_request", prices: { "1K": 0.016, "2K": 0.028 } },
  "doubao-seedream-5-0": { charge: "per_request", prices: any(0.0315) },
  "doubao-seedream-4-5": { charge: "per_request", prices: any(0.0357) },
  "doubao-seedream-4-0": { charge: "per_request", prices: any(0.0285) },
  "flux-2-pro": { charge: "per_request", prices: { "1K": 0.025, "2K": 0.035 } },
  "flux-kontext-pro": { charge: "per_request", prices: any(0.02) },
  "flux-kontext-max": { charge: "per_request", prices: any(0.04) },
  "grok-image": { charge: "per_request", prices: any(0.016) },
  "qwen-image-3.0": { charge: "per_request", prices: any(0.021) },
};

/** 16:9 output frame size of Seedance 2.x by resolution (24 fps). */
const SEEDANCE_FRAME: Readonly<Record<string, number>> = {
  "480p": 864 * 496,
  "720p": 1280 * 720,
  "1080p": 1920 * 1080,
};
const SEEDANCE_DURATION = { min: 4, max: 15 };

export function seedanceTokens(resolution: string, seconds: number): number | undefined {
  const area = SEEDANCE_FRAME[resolution];
  return area === undefined ? undefined : Math.floor((area * (24 * seconds + 1)) / 1024);
}

export interface ToapisEstimateInput {
  kind: "image" | "video";
  model: string;
  options: Record<string, unknown>;
  at?: Date;
}

function str(o: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = o[n];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

function base(input: ToapisEstimateInput, at: Date): CostEstimate {
  return {
    status: "unknown",
    currency: "USD",
    provider: TOAPIS_PROVIDER,
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

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Price a `toapis image|video` run from the list prices above. */
export function estimateToapisCost(input: ToapisEstimateInput): CostEstimate {
  const at = input.at ?? new Date();
  const out = base(input, at);
  const unknown = (reason: string, detail: string): CostEstimate => ({ ...out, reason, detail });
  const rate = TOAPIS_RATES[input.model];
  if (!rate) {
    return unknown(
      "no_price",
      `multix has no ToAPIs list price for ${input.model || "(no model)"}; check \`multix toapis quote -m ${input.model || "<model>"}\` or ${TOAPIS_PRICING_LINK}`,
    );
  }
  const o = input.options;
  const raw = str(o, "resolution");
  const defaultRes = input.kind === "video" && rate.charge === "per_token" ? "720p" : undefined;
  const resolution = raw
    ? input.kind === "image"
      ? raw.toUpperCase()
      : raw.toLowerCase()
    : defaultRes;
  let unitPrices: number[];
  if (rate.prices["*"] !== undefined) unitPrices = [rate.prices["*"]];
  else if (resolution) {
    const p = rate.prices[resolution];
    if (p === undefined) {
      return unknown(
        "unsupported",
        `${input.model} has no list price at ${resolution}; priced: ${Object.keys(rate.prices).join(", ")}`,
      );
    }
    unitPrices = [p];
  } else unitPrices = Object.values(rate.prices);
  const lowPrice = Math.min(...unitPrices);
  const highPrice = Math.max(...unitPrices);
  const assumptions = [
    `ToAPIs list price checked ${TOAPIS_PRICES_CHECKED} (${TOAPIS_PRICING_LINK}); the charge is settled in billing.cost_usd.`,
  ];
  if (unitPrices.length > 1)
    assumptions.push("--resolution not set: priced across the model's resolutions.");

  const finish = (
    low: number,
    high: number,
    proven: boolean,
    units: CostEstimate["units"],
  ): CostEstimate => ({
    ...out,
    status: "estimated",
    low_usd: round(low),
    expected_usd: round(high),
    high_usd: round(high),
    upper_bound: proven && unitPrices.length === 1 ? "proven" : "estimated",
    units,
    assumptions,
  });

  if (rate.charge === "per_request") {
    const n = Number(str(o, "count", "n") ?? 1);
    if (!Number.isInteger(n) || n <= 0)
      return unknown("missing_input", "--count must be a positive integer");
    const key = input.kind === "image" ? "output_images" : "requests";
    return finish(lowPrice * n, highPrice * n, true, { [key]: { low: n, expected: n, high: n } });
  }

  const durRaw = str(o, "duration");
  const duration = durRaw === undefined ? undefined : Number(durRaw);
  if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) {
    return unknown("missing_input", "--duration must be a positive number of seconds");
  }

  if (rate.charge === "per_second") {
    if (duration === undefined) {
      return unknown("missing_input", `Cannot price ${input.model} without --duration`);
    }
    return finish(lowPrice * duration, highPrice * duration, true, {
      output_video_seconds: { low: duration, expected: duration, high: duration },
    });
  }

  // per_token (Seedance 2.x)
  const res = resolution ?? "720p";
  const lowSec = duration ?? SEEDANCE_DURATION.min;
  const highSec = duration ?? SEEDANCE_DURATION.max;
  const lowTokens = seedanceTokens(res, lowSec);
  const highTokens = seedanceTokens(res, highSec);
  if (lowTokens === undefined || highTokens === undefined) {
    return unknown("unsupported", `No Seedance frame size known for ${res}`);
  }
  if (!raw) assumptions.push("--resolution not set: priced at the 720p default.");
  if (duration === undefined) {
    assumptions.push(
      `--duration not set: priced at ${SEEDANCE_DURATION.min}-${SEEDANCE_DURATION.max}s.`,
    );
  }
  assumptions.push(
    "Seedance bills usage.total_tokens = width × height × (24 × seconds + 1) / 1024 at the output frame size; reference video adds tokens.",
  );
  return finish((lowTokens * lowPrice) / 1e6, (highTokens * highPrice) / 1e6, false, {
    video_tokens: { low: lowTokens, expected: highTokens, high: highTokens },
  });
}
