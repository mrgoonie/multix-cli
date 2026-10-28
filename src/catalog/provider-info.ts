/**
 * Identity of each provider command group: display name and where its own
 * docs and pricing live. Pricing is left out where the provider publishes no
 * public API price page; the catalogue then says so instead of guessing.
 */

export interface ProviderInfo {
  name: string;
  homepage: string;
  docs: string;
  pricing?: string;
}

export const PROVIDER_INFO: Readonly<Record<string, ProviderInfo>> = {
  gemini: {
    name: "Google Gemini API",
    homepage: "https://ai.google.dev",
    docs: "https://ai.google.dev/gemini-api/docs",
    pricing: "https://ai.google.dev/gemini-api/docs/pricing",
  },
  openai: {
    name: "OpenAI",
    homepage: "https://openai.com/api",
    docs: "https://platform.openai.com/docs",
    pricing: "https://platform.openai.com/docs/pricing",
  },
  openrouter: {
    name: "OpenRouter",
    homepage: "https://openrouter.ai",
    docs: "https://openrouter.ai/docs",
    pricing: "https://openrouter.ai/models",
  },
  minimax: {
    name: "MiniMax",
    homepage: "https://www.minimax.io",
    docs: "https://platform.minimax.io/docs",
  },
  leonardo: {
    name: "Leonardo.Ai",
    homepage: "https://leonardo.ai",
    docs: "https://docs.leonardo.ai",
    pricing: "https://docs.leonardo.ai/docs/plan-with-the-pricing-calculator",
  },
  byteplus: {
    name: "BytePlus ModelArk",
    homepage: "https://www.byteplus.com/en/product/modelark",
    docs: "https://docs.byteplus.com/en/docs/ModelArk",
  },
  cloudflare: {
    name: "Cloudflare Workers AI",
    homepage: "https://developers.cloudflare.com/workers-ai",
    docs: "https://developers.cloudflare.com/workers-ai",
    pricing: "https://developers.cloudflare.com/workers-ai/platform/pricing",
  },
  elevenlabs: {
    name: "ElevenLabs",
    homepage: "https://elevenlabs.io",
    docs: "https://elevenlabs.io/docs",
    pricing: "https://elevenlabs.io/pricing/api",
  },
  fal: {
    name: "fal.ai",
    homepage: "https://fal.ai",
    docs: "https://docs.fal.ai",
    pricing: "https://fal.ai/pricing",
  },
  fish: {
    name: "Fish Audio",
    homepage: "https://fish.audio",
    docs: "https://docs.fish.audio",
    pricing: "https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits",
  },
  atlas: {
    name: "Atlas Cloud",
    homepage: "https://www.atlascloud.ai",
    docs: "https://www.atlascloud.ai/docs",
    pricing: "https://www.atlascloud.ai/pricing/models",
  },
  replicate: {
    name: "Replicate",
    homepage: "https://replicate.com",
    docs: "https://replicate.com/docs",
    pricing: "https://replicate.com/pricing",
  },
  runway: {
    name: "Runway API",
    homepage: "https://runwayml.com/api",
    docs: "https://docs.dev.runwayml.com",
  },
  heygen: {
    name: "HeyGen",
    homepage: "https://www.heygen.com",
    docs: "https://docs.heygen.com",
  },
};

/** Provider groups in the catalogue, in a stable order. */
export const CATALOG_PROVIDERS: readonly string[] = Object.keys(PROVIDER_INFO);
