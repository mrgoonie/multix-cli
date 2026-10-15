/**
 * multix runway image <prompt> — Gen-4 Image text-to-image, optionally guided
 * by up to three reference images (`--ref tag=path` lets the prompt mention
 * them as `@tag`). Gen-4 Image Turbo needs at least one reference.
 *
 * Images are cheap and quick, so the command waits and downloads by default;
 * --async submits and prints the task id instead.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import {
  finalizeGeneratedImages,
  imageFormatOption,
  noWebpOption,
} from "../../../core/image-webp-finalize.js";
import { createLogger } from "../../../core/logger.js";
import {
  DEFAULT_RUNWAY_IMAGE_RATIO,
  type RunwayImageModel,
  getImageModel,
  validateImageRatio,
  validatePromptText,
  validatePublicFigureThreshold,
  validateReferenceTag,
  validateSeed,
} from "../models.js";
import { createRunwayClient, runwayImageModel } from "../node-client.js";
import { parseReferenceArg, resolveImageInput } from "../node-input-files.js";
import type { RunwayContentModeration, RunwayReferenceImage } from "../types.js";
import {
  type WaitFlags,
  addOutputOptions,
  collect,
  completeTask,
  logCreated,
  nonEmpty,
  parsePositiveInt,
  printCreatedHandle,
} from "./task-flow.js";

interface ImageOpts extends WaitFlags {
  model?: string;
  ratio: string;
  ref?: string[];
  seed?: string;
  publicFigureThreshold?: string;
  async?: boolean;
  imageFormat?: string;
  webp?: boolean;
}

export interface ImagePlan {
  model: RunwayImageModel;
  promptText: string;
  ratio: string;
  references: { tag?: string; value: string }[];
  seed?: number;
  contentModeration?: RunwayContentModeration;
}

/** Validate every flag against the model before any upload or request. */
export function planImage(prompt: string, opts: ImageOpts, defaultModel: string): ImagePlan {
  const model = getImageModel(opts.model ?? defaultModel);
  const promptText = validatePromptText(prompt, true) ?? "";
  const references = (opts.ref ?? []).map(parseReferenceArg);
  if (references.length < model.minReferences || references.length > model.maxReferences) {
    const range =
      model.minReferences === 0
        ? `at most ${model.maxReferences}`
        : `${model.minReferences} to ${model.maxReferences}`;
    throw new ValidationError(
      `${model.id} takes ${range} --ref image(s); got ${references.length}`,
    );
  }
  const tags = new Set<string>();
  for (const ref of references) {
    if (!ref.value) throw new ValidationError("--ref must not be empty");
    if (ref.tag === undefined) continue;
    validateReferenceTag(ref.tag);
    if (tags.has(ref.tag)) throw new ValidationError(`Duplicate --ref tag "${ref.tag}"`);
    tags.add(ref.tag);
  }
  const plan: ImagePlan = {
    model,
    promptText,
    ratio: validateImageRatio(model, opts.ratio),
    references,
  };
  if (opts.seed !== undefined) plan.seed = validateSeed(opts.seed);
  if (opts.publicFigureThreshold) {
    plan.contentModeration = {
      publicFigureThreshold: validatePublicFigureThreshold(opts.publicFigureThreshold),
    };
  }
  return plan;
}

export function registerRunwayImageCommand(parent: Command): void {
  const cmd = parent
    .command("image <prompt>")
    .description(
      "Generate an image with Runway (default model: gen4_image, or RUNWAY_IMAGE_MODEL); waits and downloads unless --async",
    )
    .option("-m, --model <id>", "Model: gen4_image | gen4_image_turbo (needs --ref)")
    .option(
      "--ratio <w:h>",
      "Output resolution, e.g. 1920:1080, 1080:1920, 1024:1024, 1280:720 (see `multix runway models`)",
      nonEmpty,
      DEFAULT_RUNWAY_IMAGE_RATIO,
    )
    .option(
      "--ref <[tag=]path|url>",
      "Reference image (repeatable, up to 3); tag=path lets the prompt mention it as @tag",
      collect,
    )
    .option("--seed <n>", "Seed for reproducible output (0-4294967295)")
    .option(
      "--public-figure-threshold <level>",
      "Content moderation for public figures: auto | low",
    )
    .option("--async", "Submit and print the task id instead of waiting")
    .addOption(imageFormatOption())
    .addOption(noWebpOption());
  addOutputOptions(cmd, 300_000).action(async (prompt: string, opts: ImageOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false, stderr: opts.json });
    const plan = planImage(prompt, opts, runwayImageModel());
    const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");

    const client = createRunwayClient();
    const referenceImages: RunwayReferenceImage[] = [];
    for (const ref of plan.references) {
      const uri = await resolveImageInput(ref.value, "--ref", client, logger);
      referenceImages.push(ref.tag ? { uri, tag: ref.tag } : { uri });
    }
    logger.info(`Submitting Runway ${plan.model.id} text-to-image at ${plan.ratio}`);
    const created = await client.createTextToImage({
      model: plan.model.id,
      promptText: plan.promptText,
      ratio: plan.ratio,
      ...(referenceImages.length > 0 ? { referenceImages } : {}),
      ...(plan.seed !== undefined ? { seed: plan.seed } : {}),
      ...(plan.contentModeration ? { contentModeration: plan.contentModeration } : {}),
    });

    if (opts.async) {
      printCreatedHandle(created, opts.json);
      return;
    }
    logCreated(created, logger);
    await completeTask(client, created.id, {
      waitTimeoutMs,
      logger,
      download: opts.download !== false,
      showSignedUrls: opts.download === false,
      output: opts.output,
      json: opts.json,
      finalize: (files) =>
        finalizeGeneratedImages(files, {
          imageFormat: opts.imageFormat,
          webp: opts.webp,
          output: opts.output,
          logger,
        }),
    });
  });
}
