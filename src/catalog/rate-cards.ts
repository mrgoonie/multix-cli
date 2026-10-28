/**
 * Configuration-aware rate cards for video (and later image) offerings, read
 * from each provider's own model page. One card = one provider model in one
 * configuration. A dimension the source does not state stays absent from
 * `config`, so `catalog compare` never treats it as matching.
 *
 * fal: the "pricingInfoOverride" text on https://fal.ai/models/<endpoint>
 * (the summary table on fal.ai/pricing shows one blended number per model and
 * is not used). Atlas Cloud: the per-resolution price rows of
 * https://www.atlascloud.ai/pricing/models (our_price, after Atlas's discount;
 * Atlas marks token-billed rows as estimates and bills the final tokens).
 *
 * OpenRouter's models API lists video models with prompt/completion "0": that
 * is not a price, so OpenRouter video stays unpriced here.
 */

import type { PriceComponent } from "../budget/pricing-catalog.js";
import type { ConfigKey, OfferingConfig, RateCard } from "./catalog-types.js";

const CHECKED = "2026-10-28";
const falPage = (endpoint: string) => `https://fal.ai/models/${endpoint}`;
const ATLAS_PRICING = "https://www.atlascloud.ai/pricing/models";

const perSecond = (usd: number): PriceComponent[] => [
  { meter: "output_video_seconds", usd, per: 1 },
];
const perKTokens = (usd: number): PriceComponent[] => [{ meter: "video_tokens", usd, per: 1000 }];

function card(
  c: Omit<RateCard, "tier" | "currency" | "region" | "last_checked" | "verified" | "windows"> & {
    components: PriceComponent[];
    config_independent?: readonly ConfigKey[];
  },
): RateCard {
  const { components, ...rest } = c;
  return {
    ...rest,
    tier: "api-usage",
    currency: "USD",
    region: "global",
    windows: [{ components }],
    last_checked: CHECKED,
    verified: true,
  };
}

const SEEDANCE_25_FAL = "bytedance/seedance-2.5/text-to-video";
const SEEDANCE_FAL_NOTE =
  "Billed by tokens = height x width x (input video seconds + output seconds) x 24 / 1024; fal's per-second figures (720p ~$0.4730/s with audio) assume 16:9.";

function seedanceFal(resolution: string, usdPerK: number): RateCard {
  return card({
    id: `fal/seedance-2.5-t2v-${resolution}@api`,
    provider: "fal",
    models: [SEEDANCE_25_FAL],
    family: "seedance-2.5",
    task: "video",
    // The page's per-second table is "with audio"; it gives no audio-off price.
    config: { resolution, audio: true },
    basis: "list",
    token_fps: 24,
    components: perKTokens(usdPerK),
    source: falPage(SEEDANCE_25_FAL),
    notes: SEEDANCE_FAL_NOTE,
  });
}

const SEEDANCE_25_ATLAS = "bytedance/seedance-2.5/text-to-video";

function seedanceAtlas(resolution: string, usdPerS: number, officialPerS: number): RateCard {
  return card({
    id: `atlas/seedance-2.5-t2v-${resolution}@api`,
    provider: "atlas",
    models: [SEEDANCE_25_ATLAS],
    family: "seedance-2.5",
    task: "video",
    // Atlas does not say whether its per-second estimate includes audio.
    config: { resolution },
    basis: "estimated",
    components: perSecond(usdPerS),
    source: ATLAS_PRICING,
    notes: `Atlas price after its 20% discount (list $${officialPerS}/s); an estimate from video tokens, the final charge uses the tokens the task used.`,
  });
}

function klingFal(
  endpoint: string,
  tier: "pro" | "standard",
  prices: { off: number; on: number; voice: number },
): RateCard[] {
  const base = {
    provider: "fal",
    models: [endpoint],
    family: `kling-v3-${tier}`,
    task: endpoint.endsWith("image-to-video") ? ("image-to-video" as const) : ("video" as const),
    basis: "list" as const,
    source: falPage(endpoint),
  };
  const slug = endpoint.replace(/^fal-ai\/kling-video\/v3\//, "").replace(/\//g, "-");
  const variant = (id: string, config: OfferingConfig, usd: number): RateCard =>
    card({ ...base, id: `fal/kling-v3-${slug}-${id}@api`, config, components: perSecond(usd) });
  return [
    variant("audio-off", { audio: false }, prices.off),
    variant("audio-on", { audio: true }, prices.on),
    variant("voice-control", { audio: true, variant: "voice-control" }, prices.voice),
  ];
}

function kling4k(endpoint: string): RateCard {
  return card({
    id: `fal/kling-v3-4k-${endpoint.endsWith("image-to-video") ? "i2v" : "t2v"}@api`,
    provider: "fal",
    models: [endpoint],
    family: "kling-v3-4k",
    task: endpoint.endsWith("image-to-video") ? "image-to-video" : "video",
    config: { resolution: "4k" },
    config_independent: ["audio"],
    basis: "list",
    components: perSecond(0.42),
    source: falPage(endpoint),
  });
}

export const RATE_CARDS: readonly RateCard[] = [
  seedanceFal("480p", 0.0214),
  seedanceFal("720p", 0.0214),
  seedanceFal("1080p", 0.0234),
  seedanceAtlas("480p", 0.13971204, 0.17464005),
  seedanceAtlas("720p", 0.300456, 0.37557),
  seedanceAtlas("1080p", 0.591364559916, 0.739205699895),
  ...klingFal("fal-ai/kling-video/v3/pro/text-to-video", "pro", {
    off: 0.112,
    on: 0.168,
    voice: 0.196,
  }),
  ...klingFal("fal-ai/kling-video/v3/pro/image-to-video", "pro", {
    off: 0.112,
    on: 0.168,
    voice: 0.196,
  }),
  ...klingFal("fal-ai/kling-video/v3/standard/text-to-video", "standard", {
    off: 0.084,
    on: 0.126,
    voice: 0.154,
  }),
  ...klingFal("fal-ai/kling-video/v3/standard/image-to-video", "standard", {
    off: 0.084,
    on: 0.126,
    voice: 0.154,
  }),
  kling4k("fal-ai/kling-video/v3/4k/text-to-video"),
  kling4k("fal-ai/kling-video/v3/4k/image-to-video"),
];

/**
 * Frame size of a named resolution at an aspect ratio, as the provider's own
 * worked examples give it. Unknown pairs return undefined (no guessing).
 */
const FRAME_SIZES: Readonly<Record<string, readonly [number, number]>> = {
  "480p@16:9": [864, 496],
  "720p@16:9": [1280, 720],
  "1080p@16:9": [1920, 1080],
};

export function frameSize(
  resolution: string,
  aspect: string,
): readonly [number, number] | undefined {
  return FRAME_SIZES[`${resolution}@${aspect}`];
}
