/**
 * Pre-flight cost estimates for `topview *` commands (runtime-neutral).
 *
 * - Legacy commands bill credits, which have no published USD rate for API
 *   use: their estimate is "unknown" (reason credits_only) with the credit
 *   rules in the assumptions, so `--max-cost` always fails closed.
 * - `topview generate` (API Platform) is priced in USD from the static table
 *   in platform-models.ts. The high end is "proven" only when every billed
 *   unit is fixed by the request (duration, resolution, image count) and the
 *   provider does not bill measured usage; otherwise it is "estimated". A
 *   model or resolution without a price is "unknown", never $0.
 */

import type { CostEstimate } from "../../budget/cost-estimate.js";
import { MAX_PRICE_AGE_DAYS } from "../../budget/pricing-catalog.js";
import { ValidationError } from "../../core/errors.js";
import {
  type PlatformModel,
  type PlatformPrice,
  bodyDuration,
  bodyResolution,
  buildPlatformBody,
  findPlatformModel,
  mediaCounts,
} from "./platform-models.js";

type Options = Record<string, unknown>;

const ZERO_TEXT = { characters: 0, nfc_characters: 0, utf8_bytes: 0, utf16_units: 0 };

/** Credit rules quoted from the legacy docs ("Points Deduction Rules", "Getting Started"). */
const LEGACY_CREDIT_RULES: Record<string, string[]> = {
  "topview url-to-video": ["5 credits are deducted once the video is exported"],
  "topview materials-to-video": ["5 credits are deducted once the video is exported"],
  "topview export": ["5 credits are deducted once the video is exported"],
  "topview video-avatar": [
    "Avatar 1: 0.02 credits per second of generated video, plus 0.1 credits per 100 characters for text-driven video",
    "Avatar 2: 0.4 credits per second, at most 28 seconds",
  ],
  "topview product-avatar": [
    "Product replacement: 1 credit",
    "Avatar 2: 0.4 credits/s (max 28 s); Avatar 4: 0.1 credits/s (max 120 s); Avatar 4 Fast: 0.06 credits/s (max 120 s)",
    "Background removal: credit cost not documented",
  ],
  "topview product-anyshoot": ["1 credit per generated image (the reference example disagrees)"],
};

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function opt(options: Options, name: string): unknown {
  return options[name] ?? options[camel(name)];
}

function optString(options: Options, name: string): string | undefined {
  const value = opt(options, name);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function base(
  provider: string,
  model: string,
  at: Date,
): Omit<CostEstimate, "status" | "low_usd" | "expected_usd" | "high_usd" | "upper_bound"> {
  return {
    currency: "USD",
    provider,
    model,
    text: { ...ZERO_TEXT },
    units: {},
    assumptions: [],
    at: at.toISOString(),
  };
}

function unknown(
  model: string,
  reason: string,
  detail: string,
  at: Date,
  assumptions: string[] = [],
): CostEstimate {
  return {
    ...base("topview", model, at),
    status: "unknown",
    reason,
    detail,
    low_usd: null,
    expected_usd: null,
    high_usd: null,
    upper_bound: "none",
    assumptions,
  };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

function parseInput(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("--input must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function parseIntOption(raw: unknown, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n)) throw new ValidationError(`${flag} must be an integer`);
  return n;
}

function list(raw: unknown): string[] {
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === "string");
}

/** Price per second (or per image) for a resolution, choosing the reference-video price when it applies. */
function priceFor(
  prices: PlatformPrice[],
  resolution: string,
  refVideo: boolean,
  quality?: string,
) {
  const entry = prices.find(
    (p) => p.resolution === resolution && (quality === undefined || p.quality === quality),
  );
  if (!entry) return undefined;
  return {
    expected: refVideo && entry.refVideoUsd !== undefined ? entry.refVideoUsd : entry.usd,
    high: entry.usd,
  };
}

function isStale(spec: PlatformModel, at: Date): boolean {
  const ageDays = (at.getTime() - Date.parse(`${spec.verified_at}T00:00:00Z`)) / 86_400_000;
  return !(ageDays <= MAX_PRICE_AGE_DAYS);
}

/** Price a validated-shape platform body. */
export function estimatePlatformBody(
  spec: PlatformModel,
  body: Record<string, unknown>,
  at: Date = new Date(),
): CostEstimate {
  if (isStale(spec, at)) {
    return unknown(
      spec.id,
      "stale",
      `TopView price for ${spec.id} was last checked ${spec.verified_at}, over ${MAX_PRICE_AGE_DAYS} days ago`,
      at,
    );
  }
  const assumptions: string[] = [
    `Sale price from ${spec.pricing_source}, checked ${spec.verified_at}`,
  ];
  if (spec.notes) assumptions.push(spec.notes);
  let proven = !spec.usageBilled;
  const counts = mediaCounts(spec, body);

  if (spec.unit === "image") {
    const n = typeof body.n === "number" ? body.n : 1;
    const rawRes = bodyResolution(spec, body);
    const size = typeof body.size === "string" ? body.size : undefined;
    const pixelSize = size !== undefined && /^\d+\s*x\s*\d+$/i.test(size);
    const quality = typeof body.quality === "string" ? body.quality : "auto";
    const billedQuality = quality === "auto" ? "high" : quality;
    if (quality === "auto") assumptions.push("Quality auto is billed as high");
    let resolutions: string[];
    if (pixelSize) {
      resolutions = ["4k"];
      assumptions.push("A pixel size (WxH) is billed as 4k");
    } else if (typeof rawRes === "string") {
      resolutions = [rawRes];
    } else {
      resolutions = ["1k", "2k", "4k"];
      proven = false;
      assumptions.push("No resolution set: the high end assumes 4k");
    }
    const perImage = resolutions
      .map((r) => priceFor(spec.prices, r, false, billedQuality)?.high)
      .filter((p): p is number => p !== undefined);
    if (perImage.length === 0) {
      return unknown(
        spec.id,
        "no_price",
        `No TopView price for ${spec.id} at ${resolutions.join("/")} ${billedQuality}`,
        at,
      );
    }
    const low = Math.min(...perImage) * n;
    const high = Math.max(...perImage) * n;
    const expected = resolutions.length === 1 ? high : (perImage[0] as number) * n;
    assumptions.push(`${n} image(s) at ${resolutions.join("/")} ${billedQuality}`);
    return {
      ...base("topview", spec.id, at),
      status: "estimated",
      detail: `${n} image(s) x $${Math.max(...perImage)} per image (${spec.pricing_source}, verified ${spec.verified_at})`,
      low_usd: round(low),
      expected_usd: round(expected),
      high_usd: round(high),
      upper_bound: proven ? "proven" : "estimated",
      assumptions,
    };
  }

  // Video: priced per output second at one resolution.
  const rawRes = bodyResolution(spec, body);
  const known = spec.prices.map((p) => p.resolution);
  let resolutions: string[];
  if (typeof rawRes === "string") {
    resolutions = [rawRes];
  } else if (spec.defaultResolution) {
    resolutions = [spec.defaultResolution];
    assumptions.push(`Resolution defaults to ${spec.defaultResolution}`);
  } else {
    resolutions = known;
    proven = false;
    assumptions.push(
      "No resolution set and the API declares no default: the high end assumes the highest",
    );
  }
  const refVideo = counts.videos > 0;
  const rates = resolutions.map((r) => priceFor(spec.prices, r, refVideo));
  if (rates.some((r) => r === undefined)) {
    return unknown(
      spec.id,
      "no_price",
      `No TopView price for ${spec.id} at ${resolutions.join("/")}`,
      at,
    );
  }
  const perSecond = rates as { expected: number; high: number }[];

  const rawDuration = bodyDuration(spec, body);
  const range = spec.duration ?? { min: 1, max: 1, auto: false };
  let expectedSeconds: number;
  let highSeconds: number;
  if (typeof rawDuration === "number" && rawDuration > 0) {
    expectedSeconds = highSeconds = rawDuration;
  } else if (rawDuration === -1) {
    expectedSeconds = spec.defaultDuration ?? range.min;
    highSeconds = range.max;
    proven = false;
    assumptions.push(`Automatic duration (-1): the high end assumes ${range.max}s`);
  } else if (spec.defaultDuration !== undefined) {
    expectedSeconds = highSeconds = spec.defaultDuration;
    assumptions.push(`Duration defaults to ${spec.defaultDuration}s`);
  } else {
    expectedSeconds = 5;
    highSeconds = range.max;
    proven = false;
    assumptions.push(
      `No duration set and the API declares no default: the high end assumes ${range.max}s`,
    );
  }

  if (refVideo) {
    if (spec.family === "t1" || spec.family === "wan") {
      proven = false;
      assumptions.push("Reference video seconds are billed too and are not counted here");
    }
    if (perSecond.some((r) => r.expected !== r.high)) {
      assumptions.push(
        "Expected uses the reference-video rate; the high end uses the standard rate",
      );
    }
  }

  let extra = 0;
  if (spec.extraImage && counts.images > spec.extraImage.freeImages) {
    extra = (counts.images - spec.extraImage.freeImages) * spec.extraImage.usd;
    assumptions.push(
      `${counts.images - spec.extraImage.freeImages} image(s) beyond ${spec.extraImage.freeImages} free at $${spec.extraImage.usd} each`,
    );
  }

  const expectedRate = (perSecond[0] as { expected: number }).expected;
  const lowRate = Math.min(...perSecond.map((r) => r.expected));
  const highRate = Math.max(...perSecond.map((r) => r.high));
  const low = lowRate * expectedSeconds + extra;
  const expected = expectedRate * expectedSeconds + extra;
  const high = highRate * highSeconds + extra;
  assumptions.push(
    `${expectedSeconds}s at ${resolutions.length === 1 ? resolutions[0] : resolutions.join("/")}`,
  );

  return {
    ...base("topview", spec.id, at),
    status: "estimated",
    detail: `${highSeconds}s x up to $${highRate}/s${extra ? ` + $${round(extra)} images` : ""} (${spec.pricing_source}, verified ${spec.verified_at})`,
    low_usd: round(low),
    expected_usd: round(expected),
    high_usd: round(high),
    upper_bound: proven ? "proven" : "estimated",
    assumptions,
  };
}

function estimateGenerate(options: Options, at: Date): CostEstimate {
  const modelId = optString(options, "model");
  if (!modelId) {
    return unknown(
      "",
      "missing_input",
      "Cannot estimate topview generate without --model <vendor/model/mode> (a positional model is not visible to the estimator)",
      at,
    );
  }
  const spec = findPlatformModel(modelId);
  if (!spec) {
    return unknown(modelId, "no_price", `No TopView price on file for ${modelId}`, at);
  }
  let body: Record<string, unknown>;
  try {
    body = buildPlatformBody(spec, {
      prompt: optString(options, "prompt"),
      // Only the number of images matters for the price; local paths are fine here.
      images: list(opt(options, "image")),
      input: parseInput(opt(options, "input")),
      duration: parseIntOption(opt(options, "duration"), "--duration"),
      resolution: optString(options, "resolution"),
      ratio: optString(options, "ratio"),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unknown(spec.id, "invalid_input", message, at);
  }
  return estimatePlatformBody(spec, body, at);
}

/**
 * Estimate one `topview <sub>` command from its options (commander camelCase
 * or MCP kebab-case). Returns undefined for commands that never bill
 * (status, upload, credits, models), so the caller reports "unsupported".
 */
export function estimateTopviewCommand(
  command: string,
  options: Record<string, unknown>,
  at: Date = new Date(),
): CostEstimate | undefined {
  if (command === "topview generate") return estimateGenerate(options, at);
  const rules = LEGACY_CREDIT_RULES[command];
  if (!rules) return undefined;
  return unknown(
    command.replace(/^topview /, ""),
    "credits_only",
    `${command} bills TopView credits, which have no published USD rate for API use`,
    at,
    rules,
  );
}
