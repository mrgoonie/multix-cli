import type { Command } from "commander";
import { resolveKey } from "../../../core/env-loader.js";
import { createLogger } from "../../../core/logger.js";
import { resolveImageDriver, runCodexImageGeneration } from "../codex-image-driver.js";
import {
  DEFAULT_OPENAI_IMAGE_MODEL,
  parseDriver,
  parseImageFormat,
  parseImageQuality,
  parseImageSize,
  parseNumImages,
} from "../models.js";
import { generateOpenAIImage } from "../openai-image.js";

export function registerOpenAIGenerateCommand(parent: Command): void {
  parent
    .command("generate")
    .description("Generate images with OpenAI Image API or experimental Codex driver")
    .requiredOption("--prompt <text>", "Text prompt")
    .option("--driver <driver>", "api|codex|auto", "auto")
    .option(
      "-m, --model <id>",
      "Image model",
      resolveKey("OPENAI_IMAGE_MODEL") ?? DEFAULT_OPENAI_IMAGE_MODEL,
    )
    .option("--size <size>", "1024x1024|1024x1536|1536x1024|auto", "1024x1024")
    .option("--quality <q>", "low|medium|high", "medium")
    .option("--format <fmt>", "png|jpeg|webp", "png")
    .option("-n, --num-images <n>", "Number of images for API driver", "1")
    .option("--output <path>", "Save first image to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const outputFormat = parseImageFormat(opts.format);
      const driver = await resolveImageDriver({ requested: parseDriver(opts.driver) });
      const saved =
        driver === "codex"
          ? [
              (
                await runCodexImageGeneration({
                  prompt: opts.prompt,
                  outputFormat,
                  output: opts.output,
                })
              ).path,
            ]
          : await generateOpenAIImage({
              prompt: opts.prompt,
              model: opts.model,
              size: parseImageSize(opts.size),
              quality: parseImageQuality(opts.quality),
              outputFormat,
              numImages: parseNumImages(opts.numImages),
              output: opts.output,
              logger,
            });
      console.log(`\nGenerated ${saved.length} image(s):`);
      for (const file of saved) console.log(`  ${file}`);
    });
}
