/**
 * multix minimax generate — generate images with MiniMax image-01.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { requireMinimaxKey } from "../client.js";
import { generateMinimaxImage } from "../generators/image.js";
import { MINIMAX_IMAGE_MODELS, TASK_DEFAULTS } from "../models.js";

export function registerMinimaxGenerateCommand(parent: Command): void {
  parent
    .command("generate")
    .description("Generate images with MiniMax")
    .requiredOption("--prompt <text>", "Image generation prompt")
    .option("--model <id>", `Model (${[...MINIMAX_IMAGE_MODELS].join("|")})`)
    .option("--aspect-ratio <ratio>", "Aspect ratio (e.g. 1:1, 16:9)", "1:1")
    .option("--num-images <n>", "Number of images (1-9)", "1")
    .option("--output <path>", "Copy first image to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        prompt: string;
        model?: string;
        aspectRatio: string;
        numImages: string;
        output?: string;
        verbose?: boolean;
      }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const apiKey = requireMinimaxKey();
        const model = opts.model ?? TASK_DEFAULTS.image;
        const numImages = Math.min(Math.max(Number.parseInt(opts.numImages, 10) || 1, 1), 9);

        const result = await generateMinimaxImage({
          apiKey,
          prompt: opts.prompt,
          model,
          aspectRatio: opts.aspectRatio,
          numImages,
          output: opts.output,
          logger,
        });

        if (result.status === "error") {
          logger.error(result.error ?? "Unknown error");
          process.exit(1);
        }

        console.log(`\nGenerated ${result.generatedImages?.length ?? 0} image(s):`);
        for (const f of result.generatedImages ?? []) console.log(`  ${f}`);
      },
    );
}
