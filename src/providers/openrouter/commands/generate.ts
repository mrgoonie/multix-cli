/**
 * multix openrouter generate — generate images via OpenRouter chat completions.
 */

import type { Command } from "commander";
import { resolveKey } from "../../../core/env-loader.js";
import { createLogger } from "../../../core/logger.js";
import { DEFAULT_OPENROUTER_MODEL, generateOpenRouterImage } from "../client.js";

export function registerOpenRouterGenerateCommand(parent: Command): void {
  parent
    .command("generate")
    .description("Generate images via OpenRouter (uses chat completions API)")
    .requiredOption("--prompt <text>", "Image generation prompt")
    .option("--model <id>", "OpenRouter model id (e.g. google/gemini-3.1-flash-image-preview)")
    .option("--aspect-ratio <ratio>", "Aspect ratio (e.g. 1:1, 16:9)", "1:1")
    .option("--image-size <size>", "Image size hint (e.g. 1K, 2K)")
    .option("--num-images <n>", "Number of images to generate", "1")
    .option("--output <path>", "Copy first image to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        prompt: string;
        model?: string;
        aspectRatio: string;
        imageSize?: string;
        numImages: string;
        output?: string;
        verbose?: boolean;
      }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });

        // Model resolution: --model > OPENROUTER_IMAGE_MODEL env > default
        const model =
          opts.model ?? resolveKey("OPENROUTER_IMAGE_MODEL") ?? DEFAULT_OPENROUTER_MODEL;

        const numImages = Math.max(1, Number.parseInt(opts.numImages, 10) || 1);

        logger.debug(`Generating ${numImages} image(s) via OpenRouter: ${model}`);

        const result = await generateOpenRouterImage({
          prompt: opts.prompt,
          model,
          aspectRatio: opts.aspectRatio,
          imageSize: opts.imageSize,
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
        if (result.model) console.log(`Model used: ${result.model}`);
      },
    );
}
