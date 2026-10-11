/**
 * multix gemini image-to-video <imagePath> — generate a video from a starting image with Veo.
 *
 * Thin wrapper around the same Veo pipeline as `gemini generate-video`, with
 * the image as a required positional argument. Optionally accepts a closing
 * frame via --last-frame for Veo 3.1 first/last-frame interpolation.
 *
 * EXPERIMENTAL: Veo endpoints require billing and may change.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { resolveKey } from "../../../core/env-loader.js";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { maybeDownloadThumb } from "../../../core/video-thumb.js";
import { ASPECT_RATIOS, type AspectRatio, getDefaultModel } from "../models.js";
import { runVeo, veoImageFromFile } from "../veo.js";

export function registerGeminiImageToVideoCommand(parent: Command): void {
  parent
    .command("image-to-video <imagePath>")
    .alias("i2v")
    .description("Generate video from a starting image with Veo (image-to-video) [EXPERIMENTAL]")
    .requiredOption("--prompt <text>", "Motion/scene prompt")
    .option("--last-frame <path>", "Optional closing frame image (Veo 3.1)")
    .option("--model <id>", "Veo model id")
    .option("--resolution <res>", "720p|1080p", "1080p")
    .option("--aspect-ratio <ratio>", "Aspect ratio", "16:9")
    .option("--output <path>", "Copy generated video to this path")
    .option("--no-thumb", "Skip downloading the thumbnail if the API returns one")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        imagePath: string,
        opts: {
          prompt: string;
          lastFrame?: string;
          model?: string;
          resolution: string;
          aspectRatio: string;
          output?: string;
          thumb?: boolean;
          verbose?: boolean;
        },
      ) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });

        const apiKey = resolveKey("GEMINI_API_KEY");
        if (!apiKey) throw new ValidationError("GEMINI_API_KEY is not set");

        const model = opts.model ?? getDefaultModel("generate-video");
        if (!model.startsWith("veo-")) {
          throw new ValidationError(
            `Image-to-video requires a Veo model (got '${model}'). Try veo-3.1-generate-preview.`,
          );
        }

        if (!["720p", "1080p"].includes(opts.resolution)) {
          throw new ValidationError("--resolution must be 720p or 1080p");
        }
        if (!ASPECT_RATIOS.includes(opts.aspectRatio as AspectRatio)) {
          throw new ValidationError(`Invalid aspect ratio: ${opts.aspectRatio}`);
        }

        logger.info(
          "Submitting image-to-video. This may take 30s–6 minutes. Veo requires billing.",
        );

        const dest = path.join(getOutputDir(), `veo_i2v_${Date.now()}.mp4`);
        const finalOp = await runVeo(
          apiKey,
          model,
          {
            prompt: opts.prompt,
            image: veoImageFromFile(imagePath),
            lastFrame: opts.lastFrame ? veoImageFromFile(opts.lastFrame) : undefined,
            aspectRatio: opts.aspectRatio,
            resolution: opts.resolution,
          },
          dest,
          logger,
        );
        logger.success(`Saved video: ${dest}`);

        if (opts.output) {
          fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
          fs.copyFileSync(dest, opts.output);
          logger.success(`Copied to: ${opts.output}`);
        }

        await maybeDownloadThumb(finalOp.response, dest, {
          skip: opts.thumb === false,
          copyTo: opts.output,
          logger,
        });

        console.log(`\nGenerated video: ${dest}`);
      },
    );
}
