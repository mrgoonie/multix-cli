/**
 * multix runway video [prompt] — Gen-4.5 text-to-video, or image-to-video
 * with --image (Gen-4.5, Gen-4 Turbo). Paid async work never blocks by
 * default: the command prints the task id with status/resume/cancel commands.
 * --wait polls to a terminal status and downloads the result.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import {
  DEFAULT_VIDEO_DURATION,
  DEFAULT_VIDEO_RATIO,
  VIDEO_MODELS,
  assertPromptText,
  parseSeed,
  videoModelSpec,
} from "../models.js";
import { createRunwayClient, runwayVideoModel } from "../node-client.js";
import { resolveImageInput } from "../node-inputs.js";
import type { ImageToVideoRequest, TextToVideoRequest } from "../types.js";
import {
  type WaitFlagOptions,
  addOutputOptions,
  completeTask,
  logCreated,
  logEstimate,
  parsePositiveInt,
  printTaskHandle,
} from "./task-flow.js";

export interface VideoOpts extends WaitFlagOptions {
  model?: string;
  image?: string;
  ratio?: string;
  duration?: string;
  seed?: string;
  wait?: boolean;
}

export interface VideoPlan {
  mode: "text" | "image";
  /** The request without promptImage, which may need uploading first. */
  request: Omit<ImageToVideoRequest, "promptImage"> | TextToVideoRequest;
  estimatedCredits: number;
}

/** Validate every flag against the model's limits before anything is sent or billed. */
export function planVideo(prompt: string | undefined, opts: VideoOpts, model: string): VideoPlan {
  const spec = videoModelSpec(model);
  if (opts.image !== undefined && !opts.image.trim()) {
    throw new ValidationError("--image must not be empty");
  }
  const mode = opts.image ? "image" : "text";
  if (mode === "text" && !spec.textRatios) {
    throw new ValidationError(`${model} is image-to-video only: pass --image <path|url>`);
  }
  const hasPrompt = prompt !== undefined && prompt.trim() !== "";
  if (spec.promptRequired && !hasPrompt) {
    throw new ValidationError(`${model} needs a prompt`);
  }
  if (hasPrompt) assertPromptText(prompt);

  const ratios = (mode === "image" ? spec.imageRatios : spec.textRatios) ?? [];
  const ratio = opts.ratio ?? DEFAULT_VIDEO_RATIO;
  if (!ratios.includes(ratio)) {
    throw new ValidationError(
      `--ratio ${ratio} is not supported by ${model} (${mode}-to-video). Use one of: ${ratios.join(", ")}`,
    );
  }
  const duration =
    opts.duration !== undefined
      ? parsePositiveInt(opts.duration, "--duration", spec.maxDuration)
      : DEFAULT_VIDEO_DURATION;
  if (duration < spec.minDuration) {
    throw new ValidationError(
      `--duration must be from ${spec.minDuration} to ${spec.maxDuration} seconds for ${model}`,
    );
  }
  const seed = opts.seed !== undefined ? parseSeed(opts.seed) : undefined;
  const request = {
    model,
    ...(hasPrompt ? { promptText: prompt } : {}),
    ratio,
    duration,
    ...(seed !== undefined ? { seed } : {}),
  };
  return {
    mode,
    request: request as VideoPlan["request"],
    estimatedCredits: spec.creditsPerSecond * duration,
  };
}

export function registerRunwayVideoCommand(parent: Command): void {
  const models = Object.keys(VIDEO_MODELS).join(", ");
  const cmd = parent
    .command("video [prompt]")
    .description(
      `Generate video via Runway (default: ${runwayVideoModel()}); prints a task id unless --wait`,
    )
    .option("-m, --model <id>", `Model: ${models}`)
    .option("--image <path|url>", "First-frame image: image-to-video (jpg, png, webp)")
    .option("--ratio <w:h>", `Output resolution as width:height (default: ${DEFAULT_VIDEO_RATIO})`)
    .option(
      "--duration <seconds>",
      `Duration in whole seconds (default: ${DEFAULT_VIDEO_DURATION})`,
    )
    .option("--seed <n>", "Seed for reproducible output (0-4294967295)")
    .option("--wait", "Wait for the task to finish, then download the video");
  addOutputOptions(cmd, 900_000).action(async (prompt: string | undefined, opts: VideoOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false });
    if (!opts.wait && (opts.output !== undefined || opts.download !== undefined)) {
      throw new ValidationError(
        "--output and --download/--no-download need --wait (or use `multix runway status <id> --wait --download` later)",
      );
    }
    const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
    const model = (opts.model ?? runwayVideoModel()).trim();
    const plan = planVideo(prompt, opts, model);
    const client = createRunwayClient();

    logger.info(
      `Runway ${plan.mode}-to-video: ${model}, ${plan.request.ratio}, ${plan.request.duration}s`,
    );
    logEstimate(logger, plan.estimatedCredits, false);
    const created =
      plan.mode === "image"
        ? await client.imageToVideo({
            ...plan.request,
            promptImage: await resolveImageInput(opts.image as string, "--image", client, logger),
          })
        : await client.textToVideo(plan.request as TextToVideoRequest);
    logCreated(logger, created);

    if (!opts.wait) {
      printTaskHandle(created.id);
      return;
    }
    await completeTask(client, created.id, {
      waitTimeoutMs,
      logger,
      download: opts.download !== false,
      rawUrls: opts.download === false,
      output: opts.output,
    });
  });
}
