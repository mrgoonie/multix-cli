import { PollTimeoutError } from "../../../src/core/async-poll.js";
import { ConfigError, ValidationError } from "../../../src/core/errors.js";
import type { FetchLike } from "../../../src/core/fetch-json.js";
import { AtlasCloudClient } from "../../../src/providers/atlascloud/client.js";
import {
  FIELD_CANDIDATES as F,
  type FieldRequest,
  buildModelInput,
} from "../../../src/providers/atlascloud/model-input.js";
import { ATLAS_DEFAULT_MODELS } from "../../../src/providers/atlascloud/models.js";
import {
  collectOutputs,
  isSuccessStatus,
  isTerminalStatus,
  predictionErrorMessage,
} from "../../../src/providers/atlascloud/prediction-output.js";
import type {
  AtlasMediaKind,
  AtlasModelSpec,
  AtlasPrediction,
} from "../../../src/providers/atlascloud/types.js";
import type { Env } from "../config.js";
import {
  type VideoPolicy,
  assertVideoBodyWithinLimits,
  lengthRequests,
} from "./atlascloud-video-policy.js";
import { type JobResult, type ProviderAdapter, splitOutputs } from "./types.js";

const IMAGE_POLL_MS = 2000;

function atlasJob(p: AtlasPrediction): JobResult {
  const { outputs, texts } = splitOutputs(collectOutputs(p));
  const result: JobResult = {
    provider: "atlascloud",
    id: p.id,
    status: p.status,
    done: isTerminalStatus(p.status),
    succeeded: isSuccessStatus(p.status),
    outputs,
  };
  if (texts.length > 0) result.texts = texts;
  const error = predictionErrorMessage(p.error);
  if (error) result.error = error.slice(0, 300);
  return result;
}

function client(env: Env, fetch: FetchLike | undefined): AtlasCloudClient {
  const apiKey = env.ATLASCLOUD_API_KEY?.trim();
  if (!apiKey) throw new ConfigError("Atlas Cloud is not configured on this server");
  return new AtlasCloudClient({ apiKey, fetch });
}

/** The published schema validates and maps fields before any billable submit. */
async function loadSpec(
  atlas: AtlasCloudClient,
  model: string,
): Promise<AtlasModelSpec | undefined> {
  try {
    return await atlas.getModelSpec(model);
  } catch {
    return undefined;
  }
}

async function submit(
  atlas: AtlasCloudClient,
  model: string,
  fallbackKind: AtlasMediaKind,
  requests: FieldRequest[],
  video?: VideoPolicy,
): Promise<AtlasPrediction> {
  const spec = await loadSpec(atlas, model);
  if (!video) {
    return atlas.submit(spec?.endpoint ?? fallbackKind, {
      model,
      ...buildModelInput(spec, requests),
    });
  }
  // Without the schema, the defaults the API fills in (length, resolution) are unknown.
  if (!spec) {
    throw new ValidationError(
      `Model ${model}: its schema could not be loaded, so its length and resolution cannot be checked against this server's limits. Retry later; operators can pin vetted models with MULTIX_MCP_ALLOWED_MODELS.`,
    );
  }
  const body = buildModelInput(spec, [...requests, ...lengthRequests(spec, model, video)]);
  assertVideoBodyWithinLimits(spec, model, body, video);
  return atlas.submit(spec.endpoint ?? fallbackKind, { model, ...body });
}

export const atlasCloudAdapter: ProviderAdapter = {
  id: "atlascloud",
  isConfigured: (env) => Boolean(env.ATLASCLOUD_API_KEY?.trim()),
  defaultModel: (kind, opts) =>
    kind === "image"
      ? ATLAS_DEFAULT_MODELS.image
      : opts?.hasImage
        ? ATLAS_DEFAULT_MODELS.imageToVideo
        : ATLAS_DEFAULT_MODELS.video,

  async generateImage(ctx, req) {
    const atlas = client(ctx.env, ctx.fetch);
    const submitted = await submit(atlas, req.model, "image", [
      { flag: "prompt", value: req.prompt, candidates: F.prompt },
      { flag: "negative_prompt", value: req.negativePrompt, candidates: F.negativePrompt },
      { flag: "aspect_ratio", value: req.aspectRatio, candidates: F.aspectRatio },
      { flag: "num_outputs", value: req.numOutputs, candidates: F.numImages },
      { flag: "seed", value: req.seed, candidates: F.seed },
    ]);
    if (req.waitSeconds <= 0 || isTerminalStatus(submitted.status)) return atlasJob(submitted);
    try {
      return atlasJob(
        await atlas.waitForPrediction(submitted.id, {
          timeoutMs: req.waitSeconds * 1000,
          intervalMs: IMAGE_POLL_MS,
          maxIntervalMs: IMAGE_POLL_MS * 2,
        }),
      );
    } catch (error) {
      // Still running: hand back the id so the client polls with multix_prediction_status.
      if (error instanceof PollTimeoutError) return atlasJob(submitted);
      throw error;
    }
  },

  async generateVideo(ctx, req) {
    const atlas = client(ctx.env, ctx.fetch);
    const submitted = await submit(
      atlas,
      req.model,
      "video",
      [
        { flag: "prompt", value: req.prompt, candidates: F.prompt },
        { flag: "negative_prompt", value: req.negativePrompt, candidates: F.negativePrompt },
        { flag: "aspect_ratio", value: req.aspectRatio, candidates: F.aspectRatio },
        { flag: "resolution", value: req.resolution, candidates: F.resolution },
        { flag: "seed", value: req.seed, candidates: F.seed },
        {
          flag: "image_url",
          value: req.imageUrl ? [req.imageUrl] : undefined,
          candidates: F.primaryImage,
        },
      ],
      {
        maxSeconds: ctx.limits.maxVideoSeconds,
        fallbackSeconds: ctx.limits.defaultVideoSeconds,
        requestedSeconds: req.durationRequested ? req.duration : undefined,
        allowedResolutions: ctx.limits.allowedResolutions,
      },
    );
    return atlasJob(submitted);
  },

  async getStatus(ctx, id) {
    return atlasJob(await client(ctx.env, ctx.fetch).getPrediction(id));
  },
};
