import type { Command } from "commander";
import { resolveKey } from "../../../core/env-loader.js";
import {
  finalizeGeneratedImages,
  imageFormatOption,
  noWebpOption,
} from "../../../core/image-webp-finalize.js";
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
    .option(
      "--format <fmt>",
      "Provider output format png|jpeg|webp (explicit value keeps it; default png then WebP)",
    )
    .option("-n, --num-images <n>", "Number of images for API driver", "1")
    .option("--output <path>", "Save first image to this path")
    .addOption(imageFormatOption())
    .addOption(noWebpOption())
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const outputFormat = parseImageFormat(opts.format ?? "png");
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
      const finalImages = finalizeGeneratedImages(saved, {
        ...opts,
        logger,
        explicitProviderFormat: opts.format !== undefined,
      });
      console.log(`\nGenerated ${finalImages.length} image(s):`);
      for (const f of finalImages) console.log(`  ${f}`);
    });
}
