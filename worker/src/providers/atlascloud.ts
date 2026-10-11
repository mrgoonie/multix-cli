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

/** How a video request's duration is bounded on Atlas, where the API silently fills defaults. */
interface DurationPolicy {
  max: number;
  /** Server default used when the caller omitted `duration`. */
  fallback: number;
  requested: boolean;
}

/**
 * Pick the duration to send. Without a schema the model's own default is
 * unknown, so an omitted duration fails closed. With a schema that declares
 * no duration field, the model has no length control and nothing is sent.
 */
function durationToSend(
  spec: AtlasModelSpec | undefined,
  model: string,
  policy: DurationPolicy,
  requested: number,
): number | undefined {
  if (policy.requested) return requested;
  if (!spec) {
    throw new ValidationError(
      `Model ${model}: its schema is unavailable, so its default length is unknown; pass duration (at most ${policy.max}s)`,
    );
  }
  const field = F.duration.find((name) => spec.properties[name] !== undefined);
  if (!field) return undefined;
  const schemaDefault = spec.properties[field]?.default;
  return typeof schemaDefault === "number" && schemaDefault <= policy.max
    ? schemaDefault
    : policy.fallback;
}

async function submit(
  atlas: AtlasCloudClient,
  model: string,
  fallbackKind: AtlasMediaKind,
  requests: FieldRequest[],
  duration?: { policy: DurationPolicy; value: number },
): Promise<AtlasPrediction> {
  const spec = await loadSpec(atlas, model);
  const all = duration
    ? [
        ...requests,
        {
          flag: "duration",
          value: durationToSend(spec, model, duration.policy, duration.value),
          candidates: F.duration,
        },
      ]
    : requests;
  const body = buildModelInput(spec, all);
  // Schema defaults are filled in too, so re-check the duration that will actually be billed.
  const billed = body.duration;
  if (duration && typeof billed === "number" && billed > duration.policy.max) {
    throw new ValidationError(
      `Model ${model} would render ${billed}s; this server allows at most ${duration.policy.max}s`,
    );
  }
  return atlas.submit(spec?.endpoint ?? fallbackKind, { model, ...body });
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
        policy: {
          max: ctx.limits.maxVideoSeconds,
          fallback: ctx.limits.defaultVideoSeconds,
          requested: req.durationRequested,
        },
        value: req.duration,
      },
    );
    return atlasJob(submitted);
  },

  async getStatus(ctx, id) {
    return atlasJob(await client(ctx.env, ctx.fetch).getPrediction(id));
  },
};
