import { ConfigError, ValidationError } from "../../../src/core/errors.js";
import { CLOUDFLARE_VIDEO_MODEL } from "../../../src/providers/cloudflare/model-ids.js";
import {
  type CloudflareVideoConfig,
  createCloudflareVideoPrediction,
  getCloudflareVideoPrediction,
} from "../../../src/providers/cloudflare/video-client.js";
import type { Env } from "../config.js";
import { replicateJob } from "./replicate.js";
import { type ProviderAdapter, compact } from "./types.js";

function config(env: Env): CloudflareVideoConfig | undefined {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
  const gatewayId = env.CLOUDFLARE_AI_GATEWAY_ID?.trim();
  const replicateApiToken = env.REPLICATE_API_TOKEN?.trim() || env.REPLICATE_API_KEY?.trim();
  if (!accountId || !apiToken || !gatewayId || !replicateApiToken) return undefined;
  return { accountId, apiToken, gatewayId, replicateApiToken };
}

function requireConfig(env: Env): CloudflareVideoConfig {
  const resolved = config(env);
  if (!resolved) throw new ConfigError("Cloudflare video is not configured on this server");
  return resolved;
}

/**
 * Video through Cloudflare AI Gateway's Replicate route. Workers AI image
 * models return image bytes rather than URLs, so image generation is not
 * offered here.
 */
export const cloudflareAdapter: ProviderAdapter = {
  id: "cloudflare",
  isConfigured: (env) => config(env) !== undefined,
  defaultModel: (kind) => (kind === "video" ? CLOUDFLARE_VIDEO_MODEL : undefined),

  async generateVideo(ctx, req) {
    if (req.model !== CLOUDFLARE_VIDEO_MODEL) {
      throw new ValidationError(`Cloudflare supports only model ${CLOUDFLARE_VIDEO_MODEL} here`);
    }
    const prediction = await createCloudflareVideoPrediction(
      requireConfig(ctx.env),
      compact({
        prompt: req.prompt,
        negative_prompt: req.negativePrompt,
        aspect_ratio: req.aspectRatio,
        resolution: req.resolution,
        duration: req.duration,
        seed: req.seed,
        image: req.imageUrl,
      }),
      { fetch: ctx.fetch },
    );
    return replicateJob("cloudflare", prediction);
  },

  async getStatus(ctx, id) {
    const prediction = await getCloudflareVideoPrediction(requireConfig(ctx.env), id, {
      fetch: ctx.fetch,
    });
    return replicateJob("cloudflare", prediction);
  },
};
