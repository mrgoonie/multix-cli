/**
 * multix gemini generate-video — generate video with Veo via Gemini API.
 * EXPERIMENTAL: Veo endpoints require billing and may change.
 * Uses the predictLongRunning operation pattern (submit → poll until done → download).
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

export function registerGenerateVideoCommand(parent: Command): void {
  parent
    .command("generate-video")
    .description("Generate video with Veo via Gemini API [EXPERIMENTAL]")
    .requiredOption("--prompt <text>", "Video generation prompt")
    .option("--model <id>", "Veo model to use")
    .option("--resolution <res>", "Video resolution: 720p|1080p", "1080p")
    .option("--aspect-ratio <ratio>", "Aspect ratio", "16:9")
    .option(
      "--reference-images <paths...>",
      "Reference images (first=opening frame, second=closing)",
    )
    .option("--upload-timeout <ms>", "Upload timeout in ms", "120000")
    .option("--output <path>", "Copy generated video to this path")
    .option("--no-thumb", "Skip downloading the thumbnail if the API returns one")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        prompt: string;
        model?: string;
        resolution: string;
        aspectRatio: string;
        referenceImages?: string[];
        uploadTimeout: string;
        output?: string;
        thumb?: boolean;
        verbose?: boolean;
      }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });

        const apiKey = resolveKey("GEMINI_API_KEY");
        if (!apiKey) throw new ValidationError("GEMINI_API_KEY is not set");

        const model = opts.model ?? getDefaultModel("generate-video");

        if (!model.startsWith("veo-")) {
          throw new ValidationError(
            `Video generation requires a Veo model (got '${model}'). Use: veo-3.1-generate-preview, veo-3.0-generate-001, etc.`,
          );
        }

        if (!["720p", "1080p"].includes(opts.resolution)) {
          throw new ValidationError("--resolution must be 720p or 1080p");
        }

        if (!ASPECT_RATIOS.includes(opts.aspectRatio as AspectRatio)) {
          throw new ValidationError(`Invalid aspect ratio: ${opts.aspectRatio}`);
        }

        logger.debug(`Submitting video generation with ${model}...`);
        logger.info("This may take 30s–6 minutes. Veo requires billing.");

        // First reference image = opening frame, second = closing frame.
        const [first, last] = opts.referenceImages ?? [];
        const dest = path.join(getOutputDir(), `veo_generated_${Date.now()}.mp4`);
        const finalOp = await runVeo(
          apiKey,
          model,
          {
            prompt: opts.prompt,
            image: first ? veoImageFromFile(first) : undefined,
            lastFrame: last ? veoImageFromFile(last) : undefined,
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
