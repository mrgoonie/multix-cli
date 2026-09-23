import type { Command } from "commander";
import { resolveKey } from "../../../core/env-loader.js";
import { ValidationError } from "../../../core/errors.js";
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
} from "../models.js";
import { editOpenAIImage } from "../openai-image.js";

export function registerOpenAIImageToImageCommand(parent: Command): void {
  parent
    .command("image-to-image")
    .alias("i2i")
    .description("Edit images with OpenAI Image API or experimental Codex driver")
    .requiredOption("--prompt <text>", "Text prompt describing the edit")
    .requiredOption(
      "--ref <path>",
      "Reference image path or URL; repeatable",
      collect,
      [] as string[],
    )
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
    .option("--output <path>", "Save first image to this path")
    .addOption(imageFormatOption())
    .addOption(noWebpOption())
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      if (!opts.ref || opts.ref.length === 0) {
        throw new ValidationError("At least one --ref is required for image-to-image.");
      }
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const outputFormat = parseImageFormat(opts.format ?? "png");
      const driver = await resolveImageDriver({ requested: parseDriver(opts.driver) });
      const saved =
        driver === "codex"
          ? [
              (
                await runCodexImageGeneration({
                  prompt: opts.prompt,
                  refs: opts.ref,
                  outputFormat,
                  output: opts.output,
                })
              ).path,
            ]
          : await editOpenAIImage({
              prompt: opts.prompt,
              refs: opts.ref,
              model: opts.model,
              size: parseImageSize(opts.size),
              quality: parseImageQuality(opts.quality),
              outputFormat,
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

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}
