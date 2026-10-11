import { ConfigError } from "../../../src/core/errors.js";
import type { FetchLike } from "../../../src/core/fetch-json.js";
import { ReplicateClient } from "../../../src/providers/replicate/client.js";
import {
  DEFAULT_REPLICATE_IMAGE_MODEL,
  DEFAULT_REPLICATE_VIDEO_MODEL,
  isTerminalStatus,
  parseModelRef,
} from "../../../src/providers/replicate/models.js";
import { extractOutput } from "../../../src/providers/replicate/output.js";
import type { ReplicatePrediction } from "../../../src/providers/replicate/types.js";
import type { Env } from "../config.js";
import { type JobResult, type ProviderAdapter, compact, splitOutputs } from "./types.js";

function token(env: Env): string | undefined {
  return env.REPLICATE_API_TOKEN?.trim() || env.REPLICATE_API_KEY?.trim() || undefined;
}

function predictionError(error: unknown): string | undefined {
  if (error === null || error === undefined || error === "") return undefined;
  return (typeof error === "string" ? error : JSON.stringify(error)).slice(0, 300);
}

/** Replicate-shaped prediction (also used by Cloudflare's AI Gateway route) to a JobResult. */
export function replicateJob(
  provider: JobResult["provider"],
  p: Pick<ReplicatePrediction, "id" | "output" | "error"> & { status: string },
): JobResult {
  const extracted = extractOutput(p.output);
  const { outputs, texts } = splitOutputs(extracted.media.map((m) => m.url));
  texts.push(...extracted.texts);
  const result: JobResult = {
    provider,
    id: p.id,
    status: p.status,
    done: isTerminalStatus(p.status),
    succeeded: p.status === "succeeded",
    outputs,
  };
  if (texts.length > 0) result.texts = texts;
  const error = predictionError(p.error);
  if (error) result.error = error;
  return result;
}

function client(env: Env, fetch: FetchLike | undefined): ReplicateClient {
  const apiKey = token(env);
  if (!apiKey) throw new ConfigError("Replicate is not configured on this server");
  return new ReplicateClient({ apiKey, fetch });
}

export const replicateAdapter: ProviderAdapter = {
  id: "replicate",
  isConfigured: (env) => token(env) !== undefined,
  defaultModel: (kind) =>
    kind === "image" ? DEFAULT_REPLICATE_IMAGE_MODEL : DEFAULT_REPLICATE_VIDEO_MODEL,

  async generateImage(ctx, req) {
    const prediction = await client(ctx.env, ctx.fetch).createPrediction({
      model: parseModelRef(req.model),
      input: compact({
        prompt: req.prompt,
        negative_prompt: req.negativePrompt,
        aspect_ratio: req.aspectRatio,
        num_outputs: req.numOutputs,
        seed: req.seed,
      }),
      preferWaitSeconds: req.waitSeconds > 0 ? req.waitSeconds : undefined,
    });
    return replicateJob("replicate", prediction);
  },

  async generateVideo(ctx, req) {
    const prediction = await client(ctx.env, ctx.fetch).createPrediction({
      model: parseModelRef(req.model),
      input: compact({
        prompt: req.prompt,
        negative_prompt: req.negativePrompt,
        aspect_ratio: req.aspectRatio,
        resolution: req.resolution,
        duration: req.duration,
        seed: req.seed,
        image: req.imageUrl,
      }),
    });
    return replicateJob("replicate", prediction);
  },

  async getStatus(ctx, id) {
    return replicateJob("replicate", await client(ctx.env, ctx.fetch).getPrediction(id));
  },

  async cancel(ctx, id) {
    return replicateJob("replicate", await client(ctx.env, ctx.fetch).cancelPrediction(id));
  },
};
