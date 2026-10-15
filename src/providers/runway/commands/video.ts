/**
 * multix runway video <prompt> — Gen-4.5 text-to-video, or image-to-video
 * with --image (Gen-4.5, Gen-4 Turbo).
 *
 * Video is paid per second, so by default the command submits the task and
 * prints its id with status/resume/cancel commands; --wait (or --download)
 * polls until it finishes and saves the result. Every flag is validated
 * against the model registry before anything is sent.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import {
  DEFAULT_RUNWAY_DURATION,
  DEFAULT_RUNWAY_VIDEO_RATIO,
  type RunwayVideoModel,
  getVideoModel,
  validateDuration,
  validatePromptText,
  validatePublicFigureThreshold,
  validateSeed,
  validateVideoRatio,
} from "../models.js";
import { createRunwayClient, runwayVideoModel } from "../node-client.js";
import { resolveImageInput } from "../node-input-files.js";
import type { RunwayContentModeration } from "../types.js";
import {
  type WaitFlags,
  addOutputOptions,
  completeTask,
  logCreated,
  nonEmpty,
  parsePositiveInt,
  printCreatedHandle,
} from "./task-flow.js";

interface VideoOpts extends WaitFlags {
  model?: string;
  image?: string;
  duration: string;
  ratio: string;
  seed?: string;
  publicFigureThreshold?: string;
  wait?: boolean;
}

export interface VideoPlan {
  model: RunwayVideoModel;
  promptText?: string;
  duration: number;
  ratio: string;
  seed?: number;
  contentModeration?: RunwayContentModeration;
  withImage: boolean;
}

/** Validate every flag against the model before any request is made. */
export function planVideo(prompt: string, opts: VideoOpts, defaultModel: string): VideoPlan {
  const model = getVideoModel(opts.model ?? defaultModel);
  const withImage = Boolean(opts.image);
  if (!withImage && !model.textToVideo) {
    throw new ValidationError(
      `${model.id} is image-to-video only: pass --image <path|url>, or use --model gen4.5 for text-to-video`,
    );
  }
  const promptText = validatePromptText(prompt, !withImage || model.promptRequired);
  const plan: VideoPlan = {
    model,
    promptText,
    duration: validateDuration(model, opts.duration),
    ratio: validateVideoRatio(model, opts.ratio, withImage),
    withImage,
  };
  if (opts.seed !== undefined) plan.seed = validateSeed(opts.seed);
  if (opts.publicFigureThreshold) {
    plan.contentModeration = {
      publicFigureThreshold: validatePublicFigureThreshold(opts.publicFigureThreshold),
    };
  }
  return plan;
}

export function registerRunwayVideoCommand(parent: Command): void {
  const cmd = parent
    .command("video [prompt]")
    .description(
      `Generate video with Runway (default model: ${runwayVideoModel()}); submits and prints the task id unless --wait`,
    )
    .option(
      "-m, --model <id>",
      "Model: gen4.5 (text or image to video) | gen4_turbo (image to video)",
    )
    .option(
      "--image <path|url>",
      "First-frame image: JPEG/PNG/WebP file, https URL or runway:// URI",
    )
    .option("--duration <seconds>", "Length in seconds (2-10)", String(DEFAULT_RUNWAY_DURATION))
    .option(
      "--ratio <w:h>",
      "Output resolution, e.g. 1280:720, 720:1280 (image-to-video also 1104:832, 832:1104, 960:960, 1584:672)",
      nonEmpty,
      DEFAULT_RUNWAY_VIDEO_RATIO,
    )
    .option("--seed <n>", "Seed for reproducible output (0-4294967295)")
    .option(
      "--public-figure-threshold <level>",
      "Content moderation for public figures: auto | low",
    )
    .option("--wait", "Wait for the task to finish, then download the video (see --no-download)");
  addOutputOptions(cmd, 900_000).action(async (prompt: string | undefined, opts: VideoOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false, stderr: opts.json });
    const plan = planVideo(prompt ?? "", opts, runwayVideoModel());
    const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
    const wait = Boolean(opts.wait) || opts.download === true;

    const client = createRunwayClient();
    const common = {
      model: plan.model.id,
      ratio: plan.ratio,
      duration: plan.duration,
      ...(plan.seed !== undefined ? { seed: plan.seed } : {}),
      ...(plan.contentModeration ? { contentModeration: plan.contentModeration } : {}),
    };
    const mode = plan.withImage ? "image-to-video" : "text-to-video";
    let created: Awaited<ReturnType<typeof client.createTextToVideo>>;
    if (plan.withImage) {
      const uri = await resolveImageInput(opts.image ?? "", "--image", client, logger);
      logger.info(`Submitting Runway ${plan.model.id} ${mode}: ${plan.duration}s at ${plan.ratio}`);
      created = await client.createImageToVideo({
        ...common,
        promptImage: [{ uri, position: "first" }],
        ...(plan.promptText ? { promptText: plan.promptText } : {}),
      });
    } else {
      logger.info(`Submitting Runway ${plan.model.id} ${mode}: ${plan.duration}s at ${plan.ratio}`);
      created = await client.createTextToVideo({ ...common, promptText: plan.promptText ?? "" });
    }

    if (!wait) {
      printCreatedHandle(created, opts.json);
      return;
    }
    logCreated(created, logger);
    await completeTask(client, created.id, {
      waitTimeoutMs,
      logger,
      download: opts.download !== false,
      output: opts.output,
      json: opts.json,
    });
  });
}
