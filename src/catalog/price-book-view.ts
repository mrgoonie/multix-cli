/**
 * The price book as a remote surface serves it (`multix_price_book`,
 * `GET /api/v1/price-book`): one entry point over the shared builders, so the
 * Worker answers with exactly what `multix catalog providers|models|show|compare
 * --json` prints, minus the local-only parts (usage history and feedback live
 * on the user's machine).
 *
 * Runtime-neutral: the caller supplies key readiness through ProviderHooks.
 */

import { ValidationError } from "../core/errors.js";
import type { OfferingView, ProviderView, Quote, QuoteConfig } from "./catalog-types.js";
import {
  type Comparison,
  type OfferingDetail,
  type ProviderHooks,
  compareFamily,
  filterOfferings,
  listOfferings,
  listProviders,
  quoteRate,
  showOffering,
} from "./price-book.js";
import { type ConfigFlags, quoteConfig, taskOpt } from "./quote-config.js";

export const PRICE_BOOK_VIEWS = ["providers", "models", "show", "compare"] as const;
export type PriceBookViewName = (typeof PRICE_BOOK_VIEWS)[number];

export interface PriceBookArgs extends ConfigFlags {
  view: PriceBookViewName;
  provider?: string;
  family?: string;
  ref?: string;
  priced?: boolean;
  verified?: boolean;
}

export type PriceBookPayload =
  | { view: "providers"; providers: ProviderView[] }
  | { view: "models"; offerings: OfferingView[] }
  | { view: "show"; detail: OfferingDetail & { config?: QuoteConfig; quotes?: Quote[] } }
  | { view: "compare"; comparison: Comparison };

/** The `show` result without local usage and feedback; the CLI adds those. */
export function offeringWithQuotes(
  ref: string,
  flags: ConfigFlags,
  at: Date = new Date(),
): OfferingDetail & { config?: QuoteConfig; quotes?: Quote[] } {
  const detail = showOffering(ref, at);
  if (!detail) throw new ValidationError(`${ref} is not in the catalogue; list the models first`);
  const config = quoteConfig(flags);
  if (!Object.keys(config).length) return detail;
  return { ...detail, config, quotes: detail.rates.map((r) => quoteRate(r, config)) };
}

export function priceBookPayload(
  args: PriceBookArgs,
  hooks: ProviderHooks,
  at: Date = new Date(),
): PriceBookPayload {
  switch (args.view) {
    case "providers":
      return { view: "providers", providers: listProviders(hooks, at) };
    case "models": {
      const task = taskOpt(args.task);
      return {
        view: "models",
        offerings: filterOfferings(listOfferings(at), {
          ...(task ? { task } : {}),
          ...(args.provider ? { provider: args.provider } : {}),
          ...(args.family ? { family: args.family } : {}),
          ...(args.priced ? { priced: true } : {}),
          ...(args.verified ? { verified: true } : {}),
        }),
      };
    }
    case "show":
      if (!args.ref)
        throw new ValidationError(
          'ref is required, e.g. "fal:bytedance/seedance-2.0/text-to-video"',
        );
      return { view: "show", detail: offeringWithQuotes(args.ref, args, at) };
    case "compare":
      if (!args.family) throw new ValidationError('family is required, e.g. "seedance-2.0"');
      return { view: "compare", comparison: compareFamily(args.family, quoteConfig(args), at) };
    default:
      throw new ValidationError(`view must be one of ${PRICE_BOOK_VIEWS.join(", ")}`);
  }
}
