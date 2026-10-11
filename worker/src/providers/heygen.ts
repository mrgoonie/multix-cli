import { ConfigError, ValidationError } from "../../../src/core/errors.js";
import type { FetchLike } from "../../../src/core/fetch-json.js";
import { HeygenClient } from "../../../src/providers/heygen/client.js";
import { modelVideoState } from "../../../src/providers/heygen/jobs.js";
import { HEYGEN_VIDEO_MODEL } from "../../../src/providers/heygen/models.js";
import { buildModelVideoRequest } from "../../../src/providers/heygen/request-builders.js";
import type { HeygenModelVideo } from "../../../src/providers/heygen/types.js";
import type { Env } from "../config.js";
import type { JobResult, ProviderAdapter } from "./types.js";

function heygenJob(video: HeygenModelVideo): JobResult {
  const state = modelVideoState(video);
  const result: JobResult = {
    provider: "heygen",
    id: state.id,
    status: state.status,
    done: state.done,
    succeeded: state.succeeded,
    outputs: state.outputUrl ? [state.outputUrl] : [],
  };
  const error = [state.failureCode, state.failureMessage].filter(Boolean).join(": ");
  if (error) result.error = error.slice(0, 300);
  return result;
}

function client(env: Env, fetch: FetchLike | undefined): HeygenClient {
  const apiKey = env.HEYGEN_API_KEY?.trim();
  if (!apiKey) throw new ConfigError("HeyGen is not configured on this server");
  return new HeygenClient({ apiKey, fetch });
}

/** HeyGen Video model (`heygen-video-1`): text-to-video, or image-to-video with `image_url`. */
export const heygenAdapter: ProviderAdapter = {
  id: "heygen",
  isConfigured: (env) => Boolean(env.HEYGEN_API_KEY?.trim()),
  defaultModel: (kind) => (kind === "video" ? HEYGEN_VIDEO_MODEL : undefined),

  async generateVideo(ctx, req) {
    if (req.model !== HEYGEN_VIDEO_MODEL) {
      throw new ValidationError(`HeyGen supports only model ${HEYGEN_VIDEO_MODEL} here`);
    }
    if (req.negativePrompt !== undefined) {
      throw new ValidationError("negative_prompt is not supported by HeyGen");
    }
    const body = buildModelVideoRequest({
      prompt: req.prompt,
      image: req.imageUrl ? { type: "url", url: req.imageUrl } : undefined,
      duration: req.duration,
      resolution: req.resolution,
      aspectRatio: req.aspectRatio,
      seed: req.seed,
    });
    const created = await client(ctx.env, ctx.fetch).createModelVideo(body);
    return heygenJob({ video_id: created.video_id, status: created.status ?? "pending" });
  },

  async getStatus(ctx, id) {
    return heygenJob(await client(ctx.env, ctx.fetch).getModelVideo(id));
  },
};
