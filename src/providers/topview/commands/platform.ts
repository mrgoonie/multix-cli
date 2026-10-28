/**
 * API Platform commands (USD, separate key and balance from the legacy API):
 * - `topview models [--json]`: the static verified model list with prices
 * - `topview generate <vendor/model/mode>`: submit one prediction
 *
 * generate validates the request against the model's published schema before
 * anything is uploaded or sent, sends a fresh Idempotency-Key (or
 * --idempotency-key), and prints the prediction id unless --wait. TopView
 * documents no cancel endpoint for predictions.
 */

import type { Command } from "commander";
import { ProviderError, ValidationError } from "../../../core/errors.js";
import { type Logger, createLogger } from "../../../core/logger.js";
import { estimatePlatformBody } from "../cost.js";
import { createTopviewPlatformClient } from "../node-client.js";
import { precheckPlatformImage, resolvePlatformImage } from "../node-inputs.js";
import {
  TopviewAmbiguousSubmitError,
  isValidIdempotencyKey,
  newIdempotencyKey,
} from "../platform-client.js";
import {
  PLATFORM_MODELS,
  type PlatformFlags,
  type PlatformModel,
  buildPlatformBody,
  requirePlatformModel,
  validatePlatformBody,
} from "../platform-models.js";
import {
  type WaitFlagOptions,
  addOutputOptions,
  checkWaitFlags,
  completePrediction,
  logCharge,
  printTaskHandle,
} from "./task-flow.js";

const collect = (value: string, previous: string[] = []) => [...previous, value];

export interface GenerateOpts extends WaitFlagOptions {
  model?: string;
  prompt?: string;
  input?: string;
  image?: string[];
  duration?: string;
  resolution?: string;
  ratio?: string;
  idempotencyKey?: string;
}

/**
 * Stand-in URL for a local image during the pre-upload check: the body shape
 * and counts are validated before anything is uploaded or billed.
 */
const LOCAL_PLACEHOLDER = "https://local-file.topview.invalid/";

export interface GeneratePlan {
  spec: PlatformModel;
  flags: Omit<PlatformFlags, "images">;
  images: string[];
  idempotencyKey: string;
}

/** Validate every flag and the resulting body before anything is uploaded or sent. */
export function planGenerate(positional: string | undefined, opts: GenerateOpts): GeneratePlan {
  if (
    positional !== undefined &&
    opts.model !== undefined &&
    positional.trim() !== opts.model.trim()
  ) {
    throw new ValidationError("Pass the model once: as an argument or with --model");
  }
  const id = positional ?? opts.model;
  if (id === undefined) throw new ValidationError("Pass a model: <vendor/model/mode> or --model");
  const spec = requirePlatformModel(id);

  let input: Record<string, unknown> | undefined;
  if (opts.input !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(opts.input);
    } catch {
      throw new ValidationError("--input must be valid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ValidationError("--input must be a JSON object");
    }
    input = parsed as Record<string, unknown>;
  }
  let duration: number | undefined;
  if (opts.duration !== undefined) {
    if (!/^-?\d+$/.test(opts.duration.trim()))
      throw new ValidationError("--duration must be an integer");
    duration = Number(opts.duration);
  }
  if (opts.prompt !== undefined && !opts.prompt.trim())
    throw new ValidationError("--prompt must not be empty");
  const images = opts.image ?? [];
  for (const value of images) precheckPlatformImage(value, "--image");
  const idempotencyKey = opts.idempotencyKey?.trim() || newIdempotencyKey();
  if (!isValidIdempotencyKey(idempotencyKey)) {
    throw new ValidationError(
      "--idempotency-key must be 8-128 characters of letters, digits, '.', '_', ':' or '-'",
    );
  }
  const flags = {
    prompt: opts.prompt,
    input,
    duration,
    resolution: opts.resolution,
    ratio: opts.ratio,
  };
  const preview = buildPlatformBody(spec, {
    ...flags,
    images: images.map((v, i) =>
      /^https?:\/\//i.test(v.trim()) ? v.trim() : `${LOCAL_PLACEHOLDER}${i}`,
    ),
  });
  validatePlatformBody(spec, preview);
  return { spec, flags, images, idempotencyKey };
}

function logEstimate(logger: Logger, spec: PlatformModel, body: Record<string, unknown>): void {
  const estimate = estimatePlatformBody(spec, body);
  if (estimate.status !== "estimated" || estimate.high_usd === null) {
    logger.info(`Cost: unknown (${estimate.reason}); TopView reports charged_usd when done`);
    return;
  }
  const cap = estimate.upper_bound === "proven" ? "" : " (estimate; TopView bills actual usage)";
  logger.info(
    `Estimated cost: up to $${estimate.high_usd}${cap}, billed in USD from the API Platform balance`,
  );
}

function formatPrice(spec: PlatformModel): string {
  return spec.prices
    .map((p) => `${p.quality ? `${p.quality} ` : ""}${p.resolution} $${p.usd}`)
    .join(", ");
}

export function registerPlatformCommands(parent: Command): void {
  parent
    .command("models")
    .description("API Platform models multix can generate with, and their USD prices")
    .option("--json", "Print JSON (with schema fields, prices, source and verified_at)")
    .action((opts: { json?: boolean }) => {
      if (opts.json) {
        const rows = PLATFORM_MODELS.map(({ schema: _schema, ...rest }) => rest);
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      for (const m of PLATFORM_MODELS) {
        console.log(`${m.id}  [${m.task}]  per ${m.unit}: ${formatPrice(m)}`);
      }
      console.error(
        `\n  Prices verified ${PLATFORM_MODELS[0]?.verified_at}; see https://platform.topview.ai/pricing`,
      );
    });

  const cmd = parent
    .command("generate [model]")
    .description("Run an API Platform model (USD); prints the prediction id unless --wait")
    .option("-m, --model <vendor/model/mode>", "Model id (see `multix topview models`)")
    .option("--prompt <text>", "Prompt text")
    .option("--input <json>", "Request body fields as JSON (the model's documented schema)")
    .option(
      "--image <path|url>",
      "Input image: first/last frame, reference, or image to edit (repeatable)",
      collect,
      [],
    )
    .option("--duration <seconds>", "Video duration in seconds (-1: automatic where supported)")
    .option("--resolution <res>", "Resolution, e.g. 720p, 1080P, 768P, 2k")
    .option("--ratio <ratio>", "Aspect ratio, e.g. 16:9 or adaptive")
    .option("--idempotency-key <key>", "Reuse the key of an earlier attempt to retry it safely");
  addOutputOptions(cmd, 1_800_000).action(async (model: string | undefined, opts: GenerateOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
    const waitTimeoutMs = checkWaitFlags(opts, "platform");
    const plan = planGenerate(model, opts);
    const client = createTopviewPlatformClient();
    const images: string[] = [];
    for (const value of plan.images)
      images.push(await resolvePlatformImage(value, "--image", client, logger));
    const body = buildPlatformBody(plan.spec, { ...plan.flags, images });
    logEstimate(logger, plan.spec, body);
    logger.debug(`Idempotency-Key: ${plan.idempotencyKey}`);

    let prediction: Awaited<ReturnType<typeof client.submit>>;
    try {
      prediction = await client.submit(plan.spec, body, plan.idempotencyKey);
    } catch (error) {
      if (error instanceof TopviewAmbiguousSubmitError) {
        const uploaded = plan.images.some((v) => !/^https?:\/\//i.test(v.trim()))
          ? " Local --image files get new upload URLs on a re-run, which changes the request; pass public URLs to retry with the same key."
          : "";
        throw new ProviderError(
          `${error.message}. Safe retry: run the same command again with --idempotency-key ${error.idempotencyKey}.${uploaded}`,
          "topview",
          { cause: error },
        );
      }
      throw error;
    }
    logger.success(`Created TopView prediction ${prediction.id} (${prediction.status})`);
    logCharge(logger, prediction);
    if (!opts.wait) {
      printTaskHandle("platform", prediction.id);
      return;
    }
    await completePrediction(client, prediction.id, {
      waitTimeoutMs,
      logger,
      download: opts.download !== false,
      rawUrls: opts.download === false,
      output: opts.output,
    });
  });
}
