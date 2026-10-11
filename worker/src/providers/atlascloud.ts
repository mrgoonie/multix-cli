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
  AtlasSchemaProperty,
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

/** Spend limits for an Atlas video request; the Atlas API silently fills any field left out. */
interface VideoPolicy {
  maxSeconds: number;
  /** Seconds used when the caller omitted `duration` and the schema has no default. */
  fallbackSeconds: number;
  /** The caller's duration, or undefined when omitted. */
  requestedSeconds?: number;
  /** Lower-case resolutions this server allows. */
  allowedResolutions: string[];
}

/** Schema fields that set a video's length in seconds, in preference order. */
const LENGTH_FIELDS = ["duration", "seconds", "length", "num_seconds", "video_length"];

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** True when a length-named field holds a number of seconds (numeric type, enum or default). */
function isNumericLength(prop: AtlasSchemaProperty | undefined): boolean {
  if (!prop) return false;
  if (prop.type === "integer" || prop.type === "number") return true;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return prop.enum.every((e) => numericValue(e) !== undefined);
  }
  return numericValue(prop.default) !== undefined;
}

/**
 * Length for a field the caller did not set: the schema default when it is
 * within the cap, the cap when the default exceeds it, or the server fallback
 * when there is no default. The result is snapped to the schema's enum (the
 * largest value at or below it, else the smallest within the cap) and range;
 * when no allowed value fits within the cap the request is rejected.
 */
function lengthToSend(
  model: string,
  field: string,
  prop: AtlasSchemaProperty,
  policy: VideoPolicy,
): number {
  const max = policy.maxSeconds;
  const schemaDefault = numericValue(prop.default);
  const target =
    schemaDefault === undefined ? policy.fallbackSeconds : Math.min(schemaDefault, max);
  const lo = prop.minimum ?? 0;
  const hi = Math.min(prop.maximum ?? max, max);
  const enumValues = Array.isArray(prop.enum)
    ? prop.enum.map(numericValue).filter((n): n is number => n !== undefined)
    : [];
  let value: number | undefined;
  if (enumValues.length > 0) {
    const fitting = enumValues.filter((n) => n >= lo && n <= hi).sort((a, b) => a - b);
    value = fitting.filter((n) => n <= target).pop() ?? fitting[0];
  } else if (lo <= hi) {
    const clamped = Math.min(Math.max(target, lo), hi);
    value = prop.type === "integer" ? Math.floor(clamped) : clamped;
    if (value < lo) value = undefined;
  }
  if (value === undefined) {
    throw new ValidationError(
      `Model ${model}: field "${field}" has no allowed value within this server's cap of ${max}s`,
    );
  }
  return value;
}

/**
 * Length requests for a video. The caller's duration goes to the first
 * numeric length field the schema declares; every other one is sent
 * explicitly too (see lengthToSend), so the API never fills a longer default.
 * Without a schema the model's defaults are unknown, so an omitted duration
 * fails closed.
 */
function lengthRequests(
  spec: AtlasModelSpec | undefined,
  model: string,
  policy: VideoPolicy,
): FieldRequest[] {
  const requested = policy.requestedSeconds;
  if (!spec) {
    if (requested === undefined) {
      throw new ValidationError(
        `Model ${model}: its schema is unavailable, so its default length is unknown; pass duration (at most ${policy.maxSeconds}s)`,
      );
    }
    return [{ flag: "duration", value: requested, candidates: F.duration }];
  }
  const fields = LENGTH_FIELDS.filter((name) => isNumericLength(spec.properties[name]));
  const requests: FieldRequest[] = fields.map((field, i) => ({
    flag: "duration",
    value:
      i === 0 && requested !== undefined
        ? requested
        : lengthToSend(model, field, spec.properties[field] as AtlasSchemaProperty, policy),
    candidates: [field],
  }));
  // A requested duration on a model without a length field fails with "does not accept".
  if (fields.length === 0 && requested !== undefined) {
    requests.push({ flag: "duration", value: requested, candidates: F.duration });
  }
  return requests;
}

/** Re-check what will actually be billed, including values the schema filled in. */
function assertVideoBodyWithinLimits(
  spec: AtlasModelSpec | undefined,
  model: string,
  body: Record<string, unknown>,
  policy: VideoPolicy,
): void {
  for (const field of LENGTH_FIELDS) {
    const seconds = numericValue(body[field]);
    if (seconds !== undefined && seconds > policy.maxSeconds) {
      throw new ValidationError(
        `Model ${model} would render ${seconds}s; this server allows at most ${policy.maxSeconds}s`,
      );
    }
  }
  for (const field of F.resolution) {
    // A field left out is filled by the API from the schema default.
    const resolution = body[field] ?? spec?.properties[field]?.default;
    if (
      typeof resolution === "string" &&
      resolution !== "" &&
      !policy.allowedResolutions.includes(resolution.toLowerCase())
    ) {
      throw new ValidationError(
        `Model ${model} would render at ${resolution}; pass a resolution this server allows (${policy.allowedResolutions.join(", ")})`,
      );
    }
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
  const all = video ? [...requests, ...lengthRequests(spec, model, video)] : requests;
  const body = buildModelInput(spec, all);
  if (video) assertVideoBodyWithinLimits(spec, model, body, video);
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
