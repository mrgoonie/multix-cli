/**
 * Sume endpoints and routing (runtime-neutral). Sume publishes no default
 * model: every model id comes from the live catalog (GET /v1/open/catalog)
 * and is passed through unchanged.
 */

/** Provider name used in errors, receipts and URL-policy messages. */
export const SUME_PROVIDER = "sume";

export const DEFAULT_SUME_BASE_URL = "https://api.sume.com";

/** Where keys are created (Sume → Sume API → API keys). */
export const SUME_KEY_URL = "https://www.sume.com/docs/authentication";

/**
 * Base URL override and the key env names in the order the provider reads
 * them. Shared by the key lookup, the base URL trust check and `multix check`.
 */
export const SUME_ROUTING = {
  name: "SUME_BASE_URL",
  defaultUrl: DEFAULT_SUME_BASE_URL,
  keyEnvs: ["SUME_API_KEY"],
} as const;

export const SUME_PATHS = {
  catalog: "/v1/open/catalog",
  estimate: "/v1/open/estimate",
  imageGenerate: "/v1/image-router/generate",
  videoGenerate: "/v1/video-router/generate",
  uploadUrl: "/v1/files/generate-upload-url",
  jobs: "/v1/jobs",
} as const;

/** Catalog kinds served by each generate router. */
export const ROUTER_KINDS = {
  image: ["image"],
  video: ["video", "lipsync"],
} as const;
