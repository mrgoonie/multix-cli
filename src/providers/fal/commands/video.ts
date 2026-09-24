/**
 * multix fal video <prompt> — text-to-video (or image-to-video with --image-url)
 * via fal.ai.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { FAL_DEFAULTS } from "../models.js";
import { downloadResultMedia, extractMediaUrls, submitAndWait } from "../run-helpers.js";

export function registerFalVideoCommand(parent: Command): void {
  parent
    .command("video <prompt>")
    .description(`Generate video via fal.ai (default: ${FAL_DEFAULTS.videoModel})`)
    .option("-m, --model <id>", "fal model id", FAL_DEFAULTS.videoModel)
    .option("--image-url <url>", "First-frame image URL — switches to image-to-video input")
    .option("--duration <n>", "Duration in seconds (model-dependent)")
    .option("--aspect-ratio <r>", "Aspect ratio hint (e.g. 16:9, 9:16)")
    .option("--seed <n>", "Seed")
    .option("--no-download", "Skip downloading; print URLs only")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "900000")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        prompt: string,
        opts: {
          model: string;
          imageUrl?: string;
          duration?: string;
          aspectRatio?: string;
          seed?: string;
          download: boolean;
          waitTimeout: string;
          verbose?: boolean;
        },
      ) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });

        const input: Record<string, unknown> = {
          prompt,
          ...(opts.imageUrl ? { image_url: opts.imageUrl } : {}),
          ...(opts.duration ? { duration: opts.duration } : {}),
          ...(opts.aspectRatio ? { aspect_ratio: opts.aspectRatio } : {}),
          ...(opts.seed ? { seed: Number.parseInt(opts.seed, 10) } : {}),
        };

        logger.info(`Submitting to ${opts.model}...`);
        const { requestId, result } = await submitAndWait({
          model: opts.model,
          input,
          logger,
          waitTimeoutMs: Number.parseInt(opts.waitTimeout, 10) || 900_000,
        });

        const urls = extractMediaUrls(result);
        if (urls.length === 0) {
          logger.warn("No video URLs found in result.");
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (opts.download === false) {
          for (const u of urls) console.log(u);
          return;
        }

        const outDir = getOutputDir();
        const saved = await downloadResultMedia(urls, outDir, requestId, logger);
        console.log(`\nGenerated ${saved.length} file(s):`);
        for (const f of saved) console.log(`  ${f}`);
      },
    );
}
