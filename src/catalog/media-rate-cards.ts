/**
 * Offering-level list prices for image and video generation, one card per
 * configuration the provider prices separately (mode, resolution, audio,
 * duration range). Only prices read from the provider's own pricing page or
 * API go here, with that page's URL and the date it was read; an offering
 * without a card stays "unknown" in the catalogue rather than $0, and a card
 * is never converted to a per-video price unless its unit already is one.
 *
 * Speech and transcription prices live in src/budget/pricing-catalog.ts (they
 * also price runs); these cards only inform `multix catalog` for now.
 */

import type { Task } from "../capabilities/capability-types.js";
import type { RateComponent, RateConditions } from "./catalog-types.js";

export interface MediaRateCard {
  /** Stable id: "<provider>/<model>@<conditions>". */
  id: string;
  provider: string;
  /** Underlying model across providers, e.g. "seedance-2.0". */
  family: string;
  models: string[];
  task: Task;
  conditions: RateConditions;
  components: RateComponent[];
  currency: "USD" | "credits";
  usd_per_credit?: number;
  billing: "api-payg" | "credit-plan" | "subscription";
  tier: string;
  region: string;
  /** ISO instants bounding the price; open-ended when absent. */
  from?: string;
  until?: string;
  label?: string;
  /** multix command that runs the offering. */
  command?: string;
  /** Date (YYYY-MM-DD) the price was read from `source`. */
  last_checked: string;
  source: string;
  verified: boolean;
  surcharges?: string[];
  notes?: string;
}

const CHECKED = "2026-10-28";
const BYTEPLUS_PRICING = "https://docs.byteplus.com/en/docs/ModelArk/model-pricing";
const BYTEPLUS_SEEDANCE_2 = "dreamina-seedance-2-0-260128";
const BYTEPLUS_SEEDANCE_2_FAST = "dreamina-seedance-2-0-fast-260128";
const BYTEPLUS_NOTE =
  "Billed by usage.completion_tokens: (input video s + output video s) x width x height x fps / 1024 tokens. ModelArk names the model by its dated id; whether multix's `seedance-2.0` alias resolves to it is not confirmed, so the alias stays unpriced.";

const VIDEO_MODES: readonly Task[] = ["video", "image-to-video"];

type CardBase = Omit<MediaRateCard, "id" | "task" | "conditions" | "components" | "command">;

/** One card per mode (text-to-video, image-to-video) at the same price. */
function perMode(
  id: string,
  base: CardBase,
  conditions: RateConditions,
  components: RateComponent[],
  command: (task: Task) => string,
  modes: readonly Task[] = VIDEO_MODES,
): MediaRateCard[] {
  return modes.map((task) => ({
    ...base,
    id: `${id}/${task}`,
    task,
    conditions: { mode: task, ...conditions },
    components,
    command: command(task),
  }));
}

const byteplus = (model: string, family: string): CardBase => ({
  provider: "byteplus",
  family,
  models: [model],
  currency: "USD",
  billing: "api-payg",
  tier: "online-inference",
  region: "ap-southeast",
  last_checked: CHECKED,
  source: BYTEPLUS_PRICING,
  verified: true,
  notes: BYTEPLUS_NOTE,
});
const byteplusCommand = (task: Task) =>
  task === "video" ? "byteplus video" : "byteplus image-to-video";

/** BytePlus: USD per 1M output tokens (no input video), and the page's 16:9 per-second examples. */
function byteplusCards(
  model: string,
  family: string,
  tokens: [resolution: string, usdPerM: number][],
  perSecond: [resolution: string, usd: number][],
): MediaRateCard[] {
  return [
    ...tokens.flatMap(([resolution, usd]) =>
      perMode(
        `byteplus/${model}@${resolution}-tokens`,
        byteplus(model, family),
        { resolution },
        [{ unit: "output_video_tokens", amount: usd, per: 1_000_000 }],
        byteplusCommand,
      ),
    ),
    ...perSecond.flatMap(([resolution, usd]) =>
      perMode(
        `byteplus/${model}@${resolution}-16x9`,
        {
          ...byteplus(model, family),
          label: "example",
          notes: `${BYTEPLUS_NOTE} Per-second figure is the page's rounded example for 16:9, no input video.`,
        },
        { resolution, aspect_ratio: "16:9" },
        [{ unit: "video_second", amount: usd, per: 1 }],
        byteplusCommand,
      ),
    ),
  ];
}

const fal = (model: string, family: string): CardBase => ({
  provider: "fal",
  family,
  models: [model],
  currency: "USD",
  billing: "api-payg",
  tier: "api-usage",
  region: "global",
  last_checked: CHECKED,
  source: `https://fal.ai/models/${model}`,
  verified: true,
  notes:
    "Audio generation is included at no extra cost regardless of generate_audio (fal model page).",
});

/** fal Seedance 2.0 endpoints: USD per second of output video at a resolution. */
function falSeedance2(
  path: string,
  family: string,
  perSecond: [string, number][],
): MediaRateCard[] {
  return VIDEO_MODES.flatMap((task) => {
    const model = `${path}/${task === "video" ? "text-to-video" : "image-to-video"}`;
    return perSecond.flatMap(([resolution, usd]) =>
      perMode(
        `fal/${model}@${resolution}`,
        { ...fal(model, family), models: [model] },
        { resolution, audio: "any" },
        [{ unit: "video_second", amount: usd, per: 1 }],
        () => "fal video",
        [task],
      ),
    );
  });
}

export const MEDIA_RATE_CARDS: readonly MediaRateCard[] = [
  ...byteplusCards(
    BYTEPLUS_SEEDANCE_2,
    "seedance-2.0",
    [
      ["480p", 7.0],
      ["720p", 7.0],
      ["1080p", 7.7],
      ["4k", 4.0],
    ],
    [
      ["480p", 0.07],
      ["720p", 0.15],
      ["1080p", 0.37],
      ["4k", 0.78],
    ],
  ),
  ...byteplusCards(
    BYTEPLUS_SEEDANCE_2_FAST,
    "seedance-2.0-fast",
    [
      ["480p", 5.6],
      ["720p", 5.6],
    ],
    [
      ["480p", 0.06],
      ["720p", 0.12],
    ],
  ),
  ...falSeedance2("bytedance/seedance-2.0", "seedance-2.0", [
    ["720p", 0.3034],
    ["1080p", 0.682],
  ]),
  ...falSeedance2("bytedance/seedance-2.0/fast", "seedance-2.0-fast", [["720p", 0.2419]]),
  ...VIDEO_MODES.flatMap((task) => {
    const model = `fal-ai/bytedance/seedance/v1/pro/fast/${task === "video" ? "text-to-video" : "image-to-video"}`;
    return perMode(
      `fal/${model}@tokens`,
      {
        ...fal(model, "seedance-v1-pro-fast"),
        notes:
          "1M video tokens cost $1; tokens = height x width x fps x duration / 1024 (fal model page).",
      },
      {},
      [{ unit: "output_video_tokens", amount: 1, per: 1_000_000 }],
      () => "fal video",
      [task],
    );
  }),
  // Atlas lists 0.009 (list 0.01, 90% discount) without a unit; its page template
  // says "per run" while sibling models say "per second". Kept unverified until a
  // billed job settles the unit.
  ...VIDEO_MODES.flatMap((task) => {
    const model = `bytedance/seedance-v1-pro-fast/${task === "video" ? "text-to-video" : "image-to-video"}`;
    return perMode(
      `atlas/${model}`,
      {
        provider: "atlas",
        family: "seedance-v1-pro-fast",
        models: [model],
        currency: "USD",
        billing: "api-payg",
        tier: "api-usage",
        region: "global",
        last_checked: CHECKED,
        source: `https://www.atlascloud.ai/models/${model}`,
        verified: false,
        notes:
          "Catalog price 0.009 (list 0.01, 90% discount) with no stated unit; not used to quote until the unit is confirmed.",
      },
      {},
      [{ unit: "request", amount: 0.009, per: 1 }],
      (t) => (t === "video" ? "atlas video" : "atlas image-to-video"),
      [task],
    );
  }),
];
