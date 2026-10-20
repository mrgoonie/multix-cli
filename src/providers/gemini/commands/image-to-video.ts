/**
 * multix gemini image-to-video <imagePath> — generate a video from a starting image.
 *
 * Default: Gemini Omni Flash with the image (and an optional closing frame
 * via --last-frame for first/last-frame interpolation) as input parts.
 * An explicit Veo model keeps the Veo first-frame/last-frame pipeline.
 */

import path from "node:path";
import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { maybeDownloadThumb } from "../../../core/video-thumb.js";
import { ASPECT_RATIOS, type AspectRatio, getDefaultModel, videoModelFamily } from "../models.js";
import { type OmniCommonOptions, omniSettings, runOmni } from "../omni-run.js";
import { runVeo, veoImageFromFile } from "../veo.js";
import { copyToOutput } from "./generate-video.js";
import {
  OMNI_ASPECT_HELP,
  OMNI_RESOLUTION_HELP,
  addOmniOptions,
  rejectOmniFlagsForVeo,
  warnIfDeprecated,
} from "./omni-options.js";

interface ImageToVideoOptions extends OmniCommonOptions {
  prompt: string;
  lastFrame?: string;
  model?: string;
  output?: string;
  thumb?: boolean;
  verbose?: boolean;
}

export function registerGeminiImageToVideoCommand(parent: Command): void {
  const cmd = parent
    .command("image-to-video <imagePath>")
    .alias("i2v")
    .description("Generate video from a starting image with Gemini Omni Flash (default) or Veo")
    .requiredOption("--prompt <text>", "Motion/scene prompt")
    .option("--last-frame <path>", "Optional closing frame image (first/last-frame interpolation)")
    .option("--model <id>", "Video model (default gemini-omni-1.1-flash; veo-* uses Veo)")
    .option("--resolution <res>", OMNI_RESOLUTION_HELP)
    .option("--aspect-ratio <ratio>", OMNI_ASPECT_HELP)
    .option("--output <path>", "Copy generated video to this path")
    .option("--no-thumb", "Skip downloading the thumbnail if the API returns one (Veo)")
    .option("-v, --verbose", "Verbose logging");
  addOmniOptions(cmd).action(async (imagePath: string, opts: ImageToVideoOptions) => {
    const logger = createLogger({ verbose: opts.verbose ?? false });

    const model = opts.model ?? getDefaultModel("generate-video");
    const family = videoModelFamily(model);
    warnIfDeprecated(model, logger);

    if (family === "omni") {
      const settings = omniSettings(opts);
      logger.info(`Submitting image-to-video with ${model}. This may take a few minutes.`);
      const dest = path.join(getOutputDir(), `omni_i2v_${Date.now()}.mp4`);
      const { sessionPath } = await runOmni({
        model,
        prompt: opts.prompt,
        settings,
        imagePaths: opts.lastFrame ? [imagePath, opts.lastFrame] : [imagePath],
        dest,
        logger,
        command: "gemini image-to-video",
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

    logger.info("Submitting image-to-video. This may take 30s–6 minutes. Veo requires billing.");

    const dest = path.join(getOutputDir(), `veo_i2v_${Date.now()}.mp4`);
    const finalOp = await runVeo(
      model,
      {
        prompt: opts.prompt,
        image: veoImageFromFile(imagePath),
        lastFrame: opts.lastFrame ? veoImageFromFile(opts.lastFrame) : undefined,
        aspectRatio,
        resolution,
      },
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
