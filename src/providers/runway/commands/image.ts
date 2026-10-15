/**
 * multix runway image <prompt> — Gen-4 Image / Gen-4 Image Turbo text-to-image,
 * optionally guided by up to three --reference images (Turbo needs at least
 * one). Waits and downloads by default; --async returns the task id instead.
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
  DEFAULT_IMAGE_RATIO,
  IMAGE_MODELS,
  assertPromptText,
  imageModelSpec,
  parseSeed,
} from "../models.js";
import { createRunwayClient, runwayImageModel } from "../node-client.js";
import { resolveImageInput } from "../node-inputs.js";
import type { TextToImageRequest } from "../types.js";
import {
  type WaitFlagOptions,
  addOutputOptions,
  completeTask,
  logCreated,
  logEstimate,
  parsePositiveInt,
  printTaskHandle,
} from "./task-flow.js";

const TAG_RE = /^[A-Za-z][A-Za-z0-9_]{2,15}$/;

export interface ImageOpts extends WaitFlagOptions {
  model?: string;
  ratio?: string;
  seed?: string;
  reference?: string[];
  referenceTag?: string[];
  async?: boolean;
  imageFormat?: string;
  webp?: boolean;
}

export interface ImagePlan {
  /** The request without reference URIs, which may need uploading first. */
  request: Omit<TextToImageRequest, "referenceImages">;
  references: Array<{ value: string; tag?: string }>;
  estimatedCredits: number;
  approximate: boolean;
}

/** Validate every flag against the model's limits before anything is sent or billed. */
export function planImage(prompt: string, opts: ImageOpts, model: string): ImagePlan {
  const spec = imageModelSpec(model);
  assertPromptText(prompt);
  const ratio = opts.ratio ?? DEFAULT_IMAGE_RATIO;
  if (!spec.ratios.includes(ratio)) {
    throw new ValidationError(
      `--ratio ${ratio} is not supported by ${model}. Use one of: ${spec.ratios.join(", ")}`,
    );
  }
  const refs = opts.reference ?? [];
  const tags = opts.referenceTag ?? [];
  if (refs.length < spec.minReferences) {
    throw new ValidationError(`${model} needs at least ${spec.minReferences} --reference image`);
  }
  if (refs.length > spec.maxReferences) {
    throw new ValidationError(`${model} accepts at most ${spec.maxReferences} --reference images`);
  }
  if (tags.length > refs.length) {
    throw new ValidationError(
      "Each --reference-tag needs a matching --reference (paired by order)",
    );
  }
  for (const tag of tags) {
    if (!TAG_RE.test(tag)) {
      throw new ValidationError(
        `--reference-tag "${tag}" must be 3-16 letters, digits or underscores, starting with a letter`,
      );
    }
  }
  const seed = opts.seed !== undefined ? parseSeed(opts.seed) : undefined;
  return {
    request: { model, promptText: prompt, ratio, ...(seed !== undefined ? { seed } : {}) },
    references: refs.map((value, i) => (tags[i] ? { value, tag: tags[i] } : { value })),
    estimatedCredits: spec.credits,
    approximate: spec.creditsVary,
  };
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function registerRunwayImageCommand(parent: Command): void {
  const models = Object.keys(IMAGE_MODELS).join(", ");
  const cmd = parent
    .command("image <prompt>")
    .description(`Generate an image via Runway (default: ${runwayImageModel()})`)
    .option("-m, --model <id>", `Model: ${models}`)
    .option("--ratio <w:h>", `Output resolution as width:height (default: ${DEFAULT_IMAGE_RATIO})`)
    .option("--reference <path|url>", "Reference image (repeatable, up to 3)", collect)
    .option(
      "--reference-tag <tag>",
      "Tag for the reference at the same position; cite it in the prompt as @tag",
      collect,
    )
    .option("--seed <n>", "Seed for reproducible output (0-4294967295)")
    .option("--async", "Submit and return immediately with the task id")
    .addOption(imageFormatOption())
    .addOption(noWebpOption());
  addOutputOptions(cmd, 300_000).action(async (prompt: string, opts: ImageOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false });
    if (opts.async && (opts.output !== undefined || opts.download !== undefined)) {
      throw new ValidationError("--async cannot be combined with --output or --download");
    }
    const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
    const model = (opts.model ?? runwayImageModel()).trim();
    const plan = planImage(prompt, opts, model);
    const client = createRunwayClient();

    const referenceImages = [];
    for (const ref of plan.references) {
      const uri = await resolveImageInput(ref.value, "--reference", client, logger);
      referenceImages.push(ref.tag ? { uri, tag: ref.tag } : { uri });
    }
    logger.info(`Runway text-to-image: ${model}, ${plan.request.ratio}`);
    logEstimate(logger, plan.estimatedCredits, plan.approximate);
    const created = await client.textToImage({
      ...plan.request,
      ...(referenceImages.length > 0 ? { referenceImages } : {}),
    });
    logCreated(logger, created);

    if (opts.async) {
      printTaskHandle(created.id);
      return;
    }
    await completeTask(client, created.id, {
      waitTimeoutMs,
      logger,
      download: opts.download !== false,
      output: opts.output,
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
