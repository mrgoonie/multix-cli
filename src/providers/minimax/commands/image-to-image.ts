/**
 * multix minimax image-to-image — character/subject preservation via image-01
 * `subject_reference` field.
 *
 * IMPORTANT CAVEAT: MiniMax does NOT support general free-form image editing.
 * The `subject_reference` parameter only preserves a CHARACTER's identity in
 * a newly generated image — it will NOT add objects, change backgrounds, or
 * apply edits to the input image directly. Use --prompt to describe the new
 * scene; the input image is used solely as a face/character reference.
 *
 * Single --ref only (image-01 accepts one subject reference).
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { ProviderError } from "../../../core/errors.js";
import { fetchBytes } from "../../../core/http-client.js";
import { refUrl, resolveImageInput } from "../../../core/image-input.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { apiPost, requireMinimaxKey } from "../client.js";
import { TASK_DEFAULTS } from "../models.js";

interface ImageGenerationResponse {
  data?: { image_urls?: string[] };
  base_resp?: { status_code?: number; status_msg?: string };
}

export function registerMinimaxImageToImageCommand(parent: Command): void {
  parent
    .command("image-to-image")
    .alias("i2i")
    .description(
      "MiniMax character/subject preservation. CAVEAT: NOT free-form image editing — " +
        "the --ref image is used only as a character/face reference for a NEW scene described by --prompt.",
    )
    .requiredOption("--prompt <text>", "Prompt describing the desired NEW scene/composition")
    .requiredOption(
      "--ref <path>",
      "Subject reference image (URL or local path) — character/face reference only, single image",
    )
    .option("--model <id>", "Model id (default image-01)")
    .option("--aspect-ratio <ratio>", "Aspect ratio (e.g. 1:1, 16:9)", "1:1")
    .option("--num-images <n>", "Number of images (1-9)", "1")
    .option("--output <path>", "Copy first image to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        prompt: string;
        ref: string;
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

        logger.warn(
          "MiniMax i2i preserves a CHARACTER reference only. It does not edit the input image. " +
            "If you need free-form edits, use byteplus, gemini, openrouter, or leonardo image-to-image.",
        );

        const resolved = await resolveImageInput(opts.ref, { logger });
        const imageFile = refUrl(resolved);

        const payload = {
          model,
          prompt: opts.prompt,
          aspect_ratio: opts.aspectRatio,
          n: numImages,
          response_format: "url" as const,
          prompt_optimizer: true,
          subject_reference: [
            {
              type: "character",
              image_file: imageFile,
            },
          ],
        };

        logger.debug(`MiniMax i2i: model=${model}, ref=${opts.ref}, n=${numImages}`);

        let resp: ImageGenerationResponse;
        try {
          resp = await apiPost<ImageGenerationResponse>("image_generation", payload, apiKey, {
            logger,
          });
        } catch (e) {
          logger.error(e instanceof Error ? e.message : String(e));
          process.exit(1);
        }

        const imageUrls = resp.data?.image_urls ?? [];
        if (imageUrls.length === 0) {
          logger.error("No images in response");
          process.exit(1);
        }

        const outDir = getOutputDir();
        const ts = Date.now();
        const saved: string[] = [];
        for (let i = 0; i < imageUrls.length; i++) {
          const url = imageUrls[i];
          if (!url) continue;
          try {
            const bytes = await fetchBytes(url);
            const dest = path.join(outDir, `minimax-i2i-${ts}-${i + 1}.png`);
            fs.writeFileSync(dest, bytes);
            saved.push(dest);
            logger.success(`Saved: ${dest}`);
          } catch (e) {
            throw new ProviderError(
              `Failed to download image: ${e instanceof Error ? e.message : String(e)}`,
              "minimax",
            );
          }
        }

        if (opts.output && saved[0]) {
          fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
          fs.copyFileSync(saved[0], opts.output);
          logger.success(`Copied to: ${opts.output}`);
        }

        console.log(`\nGenerated ${saved.length} image(s):`);
        for (const f of saved) console.log(`  ${f}`);
      },
    );
}
