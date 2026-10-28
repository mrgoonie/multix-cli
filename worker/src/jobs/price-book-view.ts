/**
 * `multix_price_book` and `GET /api/v1/price-book`: the CLI's price book
 * (src/catalog) served remotely. Both surfaces call priceBookPayload, the
 * function behind `multix catalog providers|models|show|compare --json`, so the
 * answers cannot drift. Key readiness reports only whether the caller saved a
 * group's keys, never their values.
 */

import { z } from "zod";
import { TASKS } from "../../../src/capabilities/capability-types.js";
import {
  PRICE_BOOK_VIEWS,
  type PriceBookArgs,
  type PriceBookPayload,
  priceBookPayload,
} from "../../../src/catalog/price-book-view.js";
import type { ProviderHooks } from "../../../src/catalog/price-book.js";
import type { ProviderKeys } from "../provider-secret-names.js";
import { hasGroupKeys } from "./catalog-view.js";
import { GROUP_KEYS, GROUP_REQUIRED_KEYS } from "./cli-command-policy.js";

export const priceBookArgsSchema = {
  view: z.enum(PRICE_BOOK_VIEWS).describe("providers, models, show or compare"),
  ref: z
    .string()
    .max(200)
    .optional()
    .describe("view show: <provider>:<model>, e.g. fal:bytedance/seedance-2.0/text-to-video"),
  family: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,79}$/i)
    .optional()
    .describe("view compare (required) or models: model family, e.g. seedance-2.0"),
  provider: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .optional()
    .describe("view models: only this provider group"),
  task: z.enum(TASKS).optional().describe("Task: filters models; quotes show and compare"),
  priced: z.boolean().optional().describe("view models: only offerings with a current price"),
  verified: z.boolean().optional().describe("view models: only offerings verified by multix"),
  resolution: z.string().max(12).optional().describe("Quote at this resolution, e.g. 720p"),
  duration: z.number().positive().max(3600).optional().describe("Quote at this duration, seconds"),
  aspect_ratio: z.string().max(5).optional().describe("Quote at this aspect ratio, e.g. 16:9"),
  audio: z.boolean().optional().describe("Quote with (true) or without (false) generated audio"),
  count: z.number().int().positive().max(100).optional().describe("Outputs to quote for"),
};

export interface PriceBookInput {
  view: PriceBookArgs["view"];
  ref?: string;
  family?: string;
  provider?: string;
  task?: string;
  priced?: boolean;
  verified?: boolean;
  resolution?: string;
  duration?: number;
  aspect_ratio?: string;
  audio?: boolean;
  count?: number;
}

/** Required key rows ("A|B": either one), as `multix catalog providers` lists them. */
function requiredKeys(group: string): string[] {
  const names = GROUP_KEYS[group];
  if (!names?.length) return [];
  return (GROUP_REQUIRED_KEYS[group] ?? [[names[0]]]).map((row) => row.join("|"));
}

export function priceBookHooks(keys: ProviderKeys): ProviderHooks {
  return {
    keys: requiredKeys,
    ready: (group) => hasGroupKeys(group, keys),
  };
}

export function priceBookView(
  keys: ProviderKeys,
  input: PriceBookInput,
  at: Date = new Date(),
): PriceBookPayload {
  const { aspect_ratio, ...rest } = input;
  return priceBookPayload(
    { ...rest, ...(aspect_ratio !== undefined ? { aspectRatio: aspect_ratio } : {}) },
    priceBookHooks(keys),
    at,
  );
}
