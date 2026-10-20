/**
 * multix gemini generate-video — generate video via the Gemini API.
 * Default: Gemini Omni Flash over the Interactions API (omni-run.ts).
 * An explicit Veo model (`--model veo-…`) keeps the predictLongRunning
 * pipeline (veo.ts): submit → poll until done → download.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { maybeDownloadThumb } from "../../../core/video-thumb.js";
import { ASPECT_RATIOS, type AspectRatio, getDefaultModel, videoModelFamily } from "../models.js";
import { type OmniCommonOptions, omniSettings, runOmni } from "../omni-run.js";
import { runVeo, veoFramesFromPaths } from "../veo.js";
import {
  OMNI_ASPECT_HELP,
  OMNI_RESOLUTION_HELP,
  addOmniOptions,
  rejectOmniFlagsForVeo,
  warnIfDeprecated,
} from "./omni-options.js";

interface GenerateVideoOptions extends OmniCommonOptions {
  prompt: string;
  model?: string;
  referenceImages?: string[];
  uploadTimeout?: string;
  output?: string;
  thumb?: boolean;
  verbose?: boolean;
}

/** Copy the generated file to --output (if given) and report both paths. */
export function copyToOutput(
  dest: string,
  output: string | undefined,
  logger: ReturnType<typeof createLogger>,
): void {
  logger.success(`Saved video: ${dest}`);
  if (!output) return;
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.copyFileSync(dest, output);
  logger.success(`Copied to: ${output}`);
}

export function registerGenerateVideoCommand(parent: Command): void {
  const cmd = parent
    .command("generate-video")
    .description("Generate video with Gemini Omni Flash (default) or a Veo model")
    .requiredOption("--prompt <text>", "Video generation prompt")
    .option("--model <id>", "Video model (default gemini-omni-1.1-flash; veo-* uses Veo)")
    .option("--resolution <res>", OMNI_RESOLUTION_HELP)
    .option("--aspect-ratio <ratio>", OMNI_ASPECT_HELP)
    .option(
      "--reference-images <paths...>",
      "Images. Omni: subject/style references. Veo: first=opening frame, second=closing",
    )
    .option("--upload-timeout <ms>", "Deprecated and ignored (images are sent inline)")
    .option("--output <path>", "Copy generated video to this path")
    .option("--no-thumb", "Skip downloading the thumbnail if the API returns one (Veo)")
    .option("-v, --verbose", "Verbose logging");
  addOmniOptions(cmd).action(async (opts: GenerateVideoOptions) => {
    const logger = createLogger({ verbose: opts.verbose ?? false });
    if (opts.uploadTimeout !== undefined) {
      logger.warn("--upload-timeout is deprecated and ignored (images are sent inline)");
    }

    const model = opts.model ?? getDefaultModel("generate-video");
    const family = videoModelFamily(model);
    warnIfDeprecated(model, logger);

    if (family === "omni") {
      const settings = omniSettings(opts);
      logger.info(`Generating video with ${model}. This may take a few minutes.`);
      const dest = path.join(getOutputDir(), `omni_generated_${Date.now()}.mp4`);
      const { sessionPath } = await runOmni({
        model,
        prompt: opts.prompt,
        settings,
        imagePaths: opts.referenceImages,
        dest,
        logger,
        command: "gemini generate-video",
      });
      copyToOutput(dest, opts.output, logger);
      logger.info(`Session: ${sessionPath}`);
      console.log(`\nGenerated video: ${dest}`);
      return;
    }

    rejectOmniFlagsForVeo(opts);
    const resolution = opts.resolution ?? "1080p";
    const aspectRatio = opts.aspectRatio ?? "16:9";
    if (!["720p", "1080p"].includes(resolution)) {
      throw new ValidationError("--resolution must be 720p or 1080p for Veo models");
    }
    if (!ASPECT_RATIOS.includes(aspectRatio as AspectRatio)) {
      throw new ValidationError(`Invalid aspect ratio: ${aspectRatio}`);
    }

    logger.debug(`Submitting video generation with ${model}...`);
    logger.info("This may take 30s–6 minutes. Veo requires billing.");

    // First reference image = opening frame, second = closing frame.
    const frames = veoFramesFromPaths(opts.referenceImages);
    const dest = path.join(getOutputDir(), `veo_generated_${Date.now()}.mp4`);
    const finalOp = await runVeo(
      model,
      { prompt: opts.prompt, ...frames, aspectRatio, resolution },
      dest,
      logger,
    );

    copyToOutput(dest, opts.output, logger);

    await maybeDownloadThumb(finalOp.response, dest, {
      skip: opts.thumb === false,
      copyTo: opts.output,
      logger,
    });

    console.log(`\nGenerated video: ${dest}`);
  });
}
