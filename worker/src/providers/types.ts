import type { FetchLike } from "../../../src/core/fetch-json.js";
import type { Env, Limits } from "../config.js";

export const PROVIDER_IDS = ["replicate", "atlascloud", "heygen", "cloudflare"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Normalized async job view shared by every tool result. Outputs are URLs, never bytes. */
export interface JobResult {
  provider: ProviderId;
  id: string;
  status: string;
  done: boolean;
  succeeded: boolean;
  outputs: string[];
  /** Non-media outputs (e.g. text) the provider returned. */
  texts?: string[];
  error?: string;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: string;
  numOutputs?: number;
  seed?: number;
  /** 0 = return the prediction id immediately. */
  waitSeconds: number;
}

export interface VideoRequest {
  model: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: string;
  resolution?: string;
  duration?: number;
  seed?: number;
  /** Already SSRF-checked https URL used as the first frame / reference image. */
  imageUrl?: string;
}

export interface ProviderContext {
  env: Env;
  limits: Limits;
  /** Injected for tests; defaults to the Worker's fetch. */
  fetch?: FetchLike;
}

export interface ProviderAdapter {
  id: ProviderId;
  isConfigured(env: Env): boolean;
  /** Default model for a media kind, or undefined when the kind is unsupported. */
  defaultModel(kind: "image" | "video", opts?: { hasImage?: boolean }): string | undefined;
  generateImage?(ctx: ProviderContext, req: ImageRequest): Promise<JobResult>;
  generateVideo?(ctx: ProviderContext, req: VideoRequest): Promise<JobResult>;
  getStatus(ctx: ProviderContext, id: string): Promise<JobResult>;
  cancel?(ctx: ProviderContext, id: string): Promise<JobResult>;
}

const HTTP_URL_RE = /^https?:\/\//i;

/** Keep http(s) URLs; inline data URIs are bytes, so they are reported, not returned. */
export function splitOutputs(values: string[]): { outputs: string[]; texts: string[] } {
  const outputs: string[] = [];
  const texts: string[] = [];
  for (const value of values) {
    if (HTTP_URL_RE.test(value)) outputs.push(value);
    else if (/^data:/i.test(value)) texts.push("[inline data output omitted]");
    else texts.push(value);
  }
  return { outputs, texts };
}

/** Drop undefined values so providers apply their own defaults. */
export function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}
