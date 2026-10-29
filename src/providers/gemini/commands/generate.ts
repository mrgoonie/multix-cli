/**
 * multix gemini generate — generate images with Gemini (Nano Banana).
 * Saves generated images to the output directory.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { run } from "../../../agent/run-state.js";
import { ValidationError } from "../../../core/errors.js";
import {
  finalizeGeneratedImages,
  imageFormatOption,
  noWebpOption,
} from "../../../core/image-webp-finalize.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { outputStamp } from "../../../core/output-name.js";
import { extractImages, generateContent } from "../client.js";
import { withGeminiKey } from "../key-pool.js";
import {
  ASPECT_RATIOS,
  type AspectRatio,
  IMAGE_MODEL_DEFAULT,
  IMAGE_SIZES,
  type ImageSize,
  getDefaultModel,
} from "../models.js";

export function registerGenerateCommand(parent: Command): void {
  parent
    .command("generate")
    .description("Generate images with Gemini (Nano Banana)")
    .requiredOption("--prompt <text>", "Image generation prompt")
    .option("--model <id>", "Gemini image model to use")
    .option("--aspect-ratio <ratio>", `Aspect ratio (${ASPECT_RATIOS.join("|")})`, "1:1")
    .option("--num-images <n>", "Number of images to generate (1-4)", "1")
    .option("--size <sz>", `Image size (${IMAGE_SIZES.join("|")})`)
    .option("--output <path>", "Copy first generated image to this path")
    .addOption(imageFormatOption())
    .addOption(noWebpOption())
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        prompt: string;
        model?: string;
        aspectRatio: string;
        numImages: string;
        size?: string;
        output?: string;
        imageFormat?: string;
        webp?: boolean;
        verbose?: boolean;
      }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const model = opts.model ?? getDefaultModel("generate");
        const numImages = Math.min(Math.max(Number.parseInt(opts.numImages, 10) || 1, 1), 4);

        if (/^(models\/)?imagen-/.test(model)) {
          throw new ValidationError(
            `Imagen models are no longer served on the Gemini API; use ${IMAGE_MODEL_DEFAULT} or another Nano Banana model`,
          );
        }

        // Validate aspect ratio
        if (!ASPECT_RATIOS.includes(opts.aspectRatio as AspectRatio)) {
          throw new ValidationError(
            `Invalid aspect ratio: ${opts.aspectRatio}. Valid: ${ASPECT_RATIOS.join(", ")}`,
          );
        }

        // Validate size
        if (opts.size && !IMAGE_SIZES.includes(opts.size as ImageSize)) {
          throw new ValidationError(`Invalid size: ${opts.size}. Valid: ${IMAGE_SIZES.join(", ")}`);
        }

        logger.debug(`Generating ${numImages} image(s) with model: ${model}`);
        logger.debug(`Aspect ratio: ${opts.aspectRatio}${opts.size ? `, size: ${opts.size}` : ""}`);

        // Build image config
        const imageConfig: Record<string, string> = { aspectRatio: opts.aspectRatio };
        if (opts.size) imageConfig.imageSize = opts.size;

        const generationConfig: Record<string, unknown> = {
          responseModalities: ["IMAGE"],
          imageConfig,
        };

        const savedFiles: string[] = [];
        let failure: { error: unknown; request: number } | undefined;
        // Requests that returned images: what a failed run still owes is the rest.
        let delivered = 0;

        for (let i = 0; i < numImages; i++) {
          // A failed call throws: the run is classified from the error itself, not a log line.
          let resp: Awaited<ReturnType<typeof generateContent>>;
          try {
            resp = await withGeminiKey(
              (apiKey) =>
                generateContent(
                  {
                    model,
                    contents: [{ parts: [{ text: opts.prompt }] }],
                    generationConfig,
                  },
                  { apiKey, logger },
                ),
              { logger },
            );
          } catch (error) {
            if (savedFiles.length === 0) throw error;
            // Images already paid for stay reported; the error is rethrown once they are finished.
            failure = { error, request: i + 1 };
            break;
          }

          const images = extractImages(resp);
          if (images.length === 0) {
            logger.warn(
              `Request ${i + 1}: no images in response — model may not support image generation`,
            );
            continue;
          }

          delivered++;
          for (const img of images) {
            const outDir = getOutputDir();
            const ext = img.mimeType.includes("png") ? "png" : "jpg";
            const fname = `gemini_generated_${outputStamp()}_${i}.${ext}`;
            const dest = path.join(outDir, fname);
            fs.writeFileSync(dest, Buffer.from(img.data, "base64"));
            savedFiles.push(dest);
            logger.success(`Saved: ${dest}`);
          }
        }

        if (savedFiles.length === 0) {
          logger.error("No images were generated");
          process.exit(1);
        }

        if (failure) {
          const remaining = numImages - delivered;
          logger.warn(
            `Request ${failure.request} of ${numImages} failed after ${savedFiles.length} image(s) were saved; ${remaining} still missing`,
          );
          run.partial = { options: { "--num-images": String(remaining), "--output": null } };
        }

        try {
          // Copy first to --output if specified
          if (opts.output && savedFiles[0]) {
            fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
            fs.copyFileSync(savedFiles[0], opts.output);
            logger.success(`Copied to: ${opts.output}`);
          }

          const finalImages = finalizeGeneratedImages(savedFiles, { ...opts, logger });
          console.log(`\nGenerated ${finalImages.length} image(s):`);
          for (const f of finalImages) console.log(`  ${f}`);
        } catch (error) {
          if (!failure) throw error;
          // The request's own error decides the run; the saved images stay as written.
          logger.warn(
            `Could not finish the saved images: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (failure) throw failure.error;
      },
    );
}
