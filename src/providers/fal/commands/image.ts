/**
 * multix fal image <prompt> — text-to-image via fal.ai (default: FLUX.1 [schnell]).
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import {
  finalizeGeneratedImages,
  imageFormatOption,
  noWebpOption,
} from "../../../core/image-webp-finalize.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { FAL_DEFAULTS } from "../models.js";
import { downloadResultMedia, extractMediaUrls, submitAndWait } from "../run-helpers.js";

export function registerFalImageCommand(parent: Command): void {
  parent
    .command("image <prompt>")
    .description(
      `Generate images from a text prompt via fal.ai (default: ${FAL_DEFAULTS.imageModel})`,
    )
    .option("-m, --model <id>", "fal model id", FAL_DEFAULTS.imageModel)
    .option("--image-size <size>", "e.g. square_hd, portrait_16_9, landscape_16_9, or WxH")
    .option("-n, --num-images <n>", "Number of images", "1")
    .option("--seed <n>", "Seed")
    .option("--negative-prompt <text>", "Negative prompt")
    .option("--output <path>", "Copy first image to this path (single-image only)")
    .addOption(imageFormatOption())
    .addOption(noWebpOption())
    .option("--no-download", "Skip downloading; print URLs only")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "480000")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        prompt: string,
        opts: {
          model: string;
          imageSize?: string;
          numImages: string;
          seed?: string;
          negativePrompt?: string;
          output?: string;
          imageFormat?: string;
          webp?: boolean;
          download: boolean;
          waitTimeout: string;
          verbose?: boolean;
        },
      ) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });

        const input: Record<string, unknown> = {
          prompt,
          num_images: Number.parseInt(opts.numImages, 10) || 1,
          ...(opts.imageSize ? { image_size: opts.imageSize } : {}),
          ...(opts.seed ? { seed: Number.parseInt(opts.seed, 10) } : {}),
          ...(opts.negativePrompt ? { negative_prompt: opts.negativePrompt } : {}),
        };

        logger.info(`Submitting to ${opts.model}...`);
        const { requestId, result } = await submitAndWait({
          model: opts.model,
          input,
          logger,
          waitTimeoutMs: Number.parseInt(opts.waitTimeout, 10) || 480_000,
        });

        const urls = extractMediaUrls(result);
        if (urls.length === 0) {
          logger.warn("No image URLs found in result.");
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (opts.download === false) {
          for (const u of urls) console.log(u);
          return;
        }

        const outDir = getOutputDir();
        const saved = await downloadResultMedia(urls, outDir, requestId, logger);

        if (opts.output && saved[0]) {
          const dest = path.resolve(opts.output);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(saved[0], dest);
          logger.success(`Copied to ${dest}`);
        }

        const finalImages = finalizeGeneratedImages(saved, { ...opts, logger });
        console.log(`\nGenerated ${finalImages.length} image(s):`);
        for (const f of finalImages) console.log(`  ${f}`);
      },
    );
}
