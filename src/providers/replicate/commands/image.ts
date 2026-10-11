/**
 * multix replicate image <prompt> — text-to-image via a Replicate model
 * (default: black-forest-labs/flux-schnell; override with -m or REPLICATE_IMAGE_MODEL).
 * Flags map to the common FLUX-style input names; `--input` merges any other
 * model-specific fields, and `replicate run` covers fully custom schemas.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import {
  finalizeGeneratedImages,
  imageFormatOption,
  noWebpOption,
} from "../../../core/image-webp-finalize.js";
import { parseJsonInput } from "../../../core/json-input.js";
import { createLogger } from "../../../core/logger.js";
import { parseModelRef } from "../models.js";
import { createReplicateClient, replicateImageModel } from "../node-client.js";
import {
  type FlowOptions,
  addFlowOptions,
  executePrediction,
  parsePositiveInt,
} from "./prediction-flow.js";

const ASPECT_RE = /^\d{1,2}:\d{1,2}$/;
const OUTPUT_FORMATS = ["webp", "jpg", "png"];

interface ImageOpts extends FlowOptions {
  model?: string;
  aspectRatio?: string;
  numOutputs?: string;
  seed?: string;
  outputFormat?: string;
  input?: string;
  imageFormat?: string;
  webp?: boolean;
}

/** Build and validate the model input from the wrapper flags. */
export function buildImageInput(prompt: string, opts: ImageOpts): Record<string, unknown> {
  if (!prompt.trim()) throw new ValidationError("Prompt must not be empty");
  if (opts.aspectRatio && !ASPECT_RE.test(opts.aspectRatio)) {
    throw new ValidationError("--aspect-ratio must look like 16:9");
  }
  if (opts.outputFormat && !OUTPUT_FORMATS.includes(opts.outputFormat)) {
    throw new ValidationError(`--output-format must be one of: ${OUTPUT_FORMATS.join(", ")}`);
  }
  const extra = opts.input ? parseJsonInput(opts.input) : {};
  return {
    ...extra,
    prompt,
    ...(opts.aspectRatio ? { aspect_ratio: opts.aspectRatio } : {}),
    ...(opts.numOutputs
      ? { num_outputs: parsePositiveInt(opts.numOutputs, "--num-outputs", 10) }
      : {}),
    ...(opts.seed !== undefined ? { seed: parseSeed(opts.seed) } : {}),
    ...(opts.outputFormat ? { output_format: opts.outputFormat } : {}),
  };
}

export function parseSeed(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0)
    throw new ValidationError("--seed must be a non-negative integer");
  return n;
}

export function registerReplicateImageCommand(parent: Command): void {
  const cmd = parent
    .command("image <prompt>")
    .description(`Generate images via Replicate (default: ${replicateImageModel()})`)
    .option("-m, --model <ref>", "Model: owner/name or owner/name:version")
    .option("--aspect-ratio <ratio>", "Aspect ratio, e.g. 1:1, 16:9, 9:16")
    .option("-n, --num-outputs <n>", "Number of images (model limits apply)")
    .option("--seed <n>", "Seed for reproducible output")
    .option("--output-format <fmt>", "Provider output format: webp | jpg | png")
    .option("--input <json>", "Extra model-specific input fields as JSON or @file.json")
    .addOption(imageFormatOption())
    .addOption(noWebpOption());
  addFlowOptions(cmd, 300_000).action(async (prompt: string, opts: ImageOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false });
    const model = parseModelRef(opts.model ?? replicateImageModel());
    const input = buildImageInput(prompt, opts);
    const client = createReplicateClient();
    await executePrediction({
      client,
      model,
      input,
      opts,
      logger,
      finalize: (files) =>
        finalizeGeneratedImages(files, {
          imageFormat: opts.imageFormat,
          webp: opts.webp,
          output: opts.output,
          logger,
          explicitProviderFormat: Boolean(opts.outputFormat),
        }),
    });
  });
}
