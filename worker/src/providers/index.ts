import { atlasCloudAdapter } from "./atlascloud.js";
import { cloudflareAdapter } from "./cloudflare.js";
import { heygenAdapter } from "./heygen.js";
import { replicateAdapter } from "./replicate.js";
import type { ProviderAdapter, ProviderId } from "./types.js";

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  replicate: replicateAdapter,
  atlascloud: atlasCloudAdapter,
  heygen: heygenAdapter,
  cloudflare: cloudflareAdapter,
};

export * from "./types.js";
