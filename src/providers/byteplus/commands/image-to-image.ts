/**
 * multix byteplus image-to-image — Seedream/Seededit reference-driven generation.
 * Wraps generateSeedream with required --ref input(s).
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { createBytePlusClient } from "../client.js";
import { generateSeedream } from "../generators/image.js";

export function registerBytePlusImageToImageCommand(parent: Command): void {
  parent
    .command("image-to-image")
    .alias("i2i")
    .description(
      "Edit/transform image(s) with BytePlus Seedream/Seededit using one or more reference images",
    )
    .requiredOption("--prompt <text>", "Text prompt describing the edit")
    .requiredOption(
      "--ref <path>",
      "Reference image (URL or local path); repeatable for multi-ref",
      collect,
      [] as string[],
    )
    .option("-m, --model <id>", "Model id (default seedream-4-0-250828)")
    .option("--size <size>", "Image size (e.g. 1024x1024, 1K, 2K, 4K)")
    .option("--aspect-ratio <ratio>", "Aspect ratio (e.g. 1:1, 16:9, 9:16); maps to size")
    .option("-n, --num-images <n>", "Number of images", "1")
    .option("--seed <n>", "Fixed seed")
    .option("--no-watermark", "Disable watermark")
    .option("--output <path>", "Save single image to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        prompt: string;
        ref: string[];
        model?: string;
        size?: string;
        aspectRatio?: string;
        numImages: string;
        seed?: string;
        watermark: boolean;
        output?: string;
        verbose?: boolean;
      }) => {
        if (!opts.ref || opts.ref.length === 0) {
          throw new Error("At least one --ref is required for image-to-image.");
        }
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const client = createBytePlusClient();

        const saved = await generateSeedream(client, {
          prompt: opts.prompt,
          model: opts.model,
          size: opts.size,
          aspectRatio: opts.aspectRatio,
          numImages: Number.parseInt(opts.numImages, 10) || 1,
          seed: opts.seed ? Number.parseInt(opts.seed, 10) : undefined,
          watermark: opts.watermark,
          inputImages: opts.ref,
          output: opts.output,
          logger,
        });

        console.log(`\nGenerated ${saved.length} image(s):`);
        for (const f of saved) console.log(`  ${f.path}`);
      },
    );
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}
