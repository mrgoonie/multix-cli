/**
 * multix gemini generate — generate images with Gemini (Nano Banana / Imagen 4).
 * Saves generated images to the output directory.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { ValidationError } from "../../../core/errors.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { generateContent, extractImages } from "../client.js";
import {
  getDefaultModel,
  ASPECT_RATIOS,
  IMAGE_SIZES,
  type AspectRatio,
  type ImageSize,
} from "../models.js";

export function registerGenerateCommand(parent: Command): void {
  parent
    .command("generate")
    .description("Generate images with Gemini (Nano Banana / Imagen 4)")
    .requiredOption("--prompt <text>", "Image generation prompt")
    .option("--model <id>", "Gemini image model to use")
    .option(
      "--aspect-ratio <ratio>",
      `Aspect ratio (${ASPECT_RATIOS.join("|")})`,
      "1:1",
    )
    .option("--num-images <n>", "Number of images to generate (1-4)", "1")
    .option("--size <sz>", `Image size (${IMAGE_SIZES.join("|")})`)
    .option("--output <path>", "Copy first generated image to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: {
      prompt: string;
      model?: string;
      aspectRatio: string;
      numImages: string;
      size?: string;
      output?: string;
      verbose?: boolean;
    }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const model = opts.model ?? getDefaultModel("generate");
      const numImages = Math.min(Math.max(Number.parseInt(opts.numImages, 10) || 1, 1), 4);

      // Validate aspect ratio
      if (!ASPECT_RATIOS.includes(opts.aspectRatio as AspectRatio)) {
        throw new ValidationError(`Invalid aspect ratio: ${opts.aspectRatio}. Valid: ${ASPECT_RATIOS.join(", ")}`);
      }

      // Validate size
      if (opts.size && !IMAGE_SIZES.includes(opts.size as ImageSize)) {
        throw new ValidationError(`Invalid size: ${opts.size}. Valid: ${IMAGE_SIZES.join(", ")}`);
      }

      logger.debug(`Generating ${numImages} image(s) with model: ${model}`);
      logger.debug(`Aspect ratio: ${opts.aspectRatio}${opts.size ? `, size: ${opts.size}` : ""}`);

      // Build image config
      const imageConfig: Record<string, string> = { aspectRatio: opts.aspectRatio };
      if (opts.size) imageConfig["imageSize"] = opts.size;

      const generationConfig: Record<string, unknown> = {
        responseModalities: ["IMAGE"],
        imageConfig,
      };

      const savedFiles: string[] = [];

      for (let i = 0; i < numImages; i++) {
        try {
          const resp = await generateContent({
            model,
            contents: [{ parts: [{ text: opts.prompt }] }],
            generationConfig,
          });

          const images = extractImages(resp);
          if (images.length === 0) {
            logger.warn(`Request ${i + 1}: no images in response — model may not support image generation`);
            continue;
          }

          for (const img of images) {
            const outDir = getOutputDir();
            const ext = img.mimeType.includes("png") ? "png" : "jpg";
            const fname = `gemini_generated_${Date.now()}_${i}.${ext}`;
            const dest = path.join(outDir, fname);
            fs.writeFileSync(dest, Buffer.from(img.data, "base64"));
            savedFiles.push(dest);
            logger.success(`Saved: ${dest}`);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.error(`Generation failed: ${msg}`);
          process.exit(1);
        }
      }

      if (savedFiles.length === 0) {
        logger.error("No images were generated");
        process.exit(1);
      }

      // Copy first to --output if specified
      if (opts.output && savedFiles[0]) {
        fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
        fs.copyFileSync(savedFiles[0], opts.output);
        logger.success(`Copied to: ${opts.output}`);
      }

      console.log(`\nGenerated ${savedFiles.length} image(s):`);
      for (const f of savedFiles) console.log(`  ${f}`);
    });
}
