/**
 * ToAPIs (https://toapis.com) — an API aggregator that resells many image and
 * video models behind one key and one balance. Constants only: no node:* imports.
 */

export const TOAPIS_PROVIDER = "toapis";
export const DEFAULT_TOAPIS_BASE_URL = "https://toapis.com";
export const TOAPIS_DASHBOARD_LINK = "https://toapis.com/dashboard/tokens";
export const TOAPIS_DOCS_LINK = "https://docs.toapis.com";
export const TOAPIS_PRICING_LINK = "https://toapis.com/pricing";
/** Public, unauthenticated price quote used by the pricing page. Not in the docs. */
export const TOAPIS_QUOTE_PATH = "/api/sku/quote/batch";

/**
 * Base URL override and the key env names in the order the provider reads
 * them. Shared by the key lookup, the base URL trust check and `multix check`.
 */
export const TOAPIS_ROUTING = {
  name: "TOAPIS_BASE_URL",
  defaultUrl: DEFAULT_TOAPIS_BASE_URL,
  keyEnvs: ["TOAPIS_API_KEY"],
} as const;

export const TOAPIS_IMAGE_MODEL_ENV = "TOAPIS_IMAGE_MODEL";
export const TOAPIS_VIDEO_MODEL_ENV = "TOAPIS_VIDEO_MODEL";

/** Seedream 4.5: priced flat per image and close to the ByteDance list price. */
export const DEFAULT_TOAPIS_IMAGE_MODEL = "doubao-seedream-4-5";
/** Seedance 2.0 Fast: billed by usage.total_tokens at a rate below BytePlus. */
export const DEFAULT_TOAPIS_VIDEO_MODEL = "seedance-2-fast";
