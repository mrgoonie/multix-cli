/**
 * multix leonardo generate <prompt> — image generation.
 *
 * Routes:
 *   - GPT Image family (modelId starts with "gpt-image-") → v2 endpoint, nested params shape.
 *   - All others → v1 /generations endpoint (Stable Diffusion family).
 *
 * Polls until COMPLETE, then downloads images to MULTIX_OUTPUT_DIR
 * (default ./multix-output/) with name leonardo-<id>-<i>.<ext>.
 * If --output <path> is given and result has 1 image, copies to that path.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { downloadFile } from "../../../core/http-client.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { createLeonardoClient } from "../client.js";
import { LEONARDO_DEFAULTS, isGptImageModel } from "../models.js";
import { poll } from "../poll.js";
import type {
  CreateGenerationInput,
  CreateGenerationResponse,
  CreateV2GenerationResponse,
  GetGenerationResponse,
} from "../types.js";

function extFromUrl(url: string, fallback = ".png"): string {
  try {
    const u = new URL(url);
    const e = path.extname(u.pathname);
    return e.length > 0 ? e : fallback;
  } catch {
    return fallback;
  }
}

function autoFilename(generationId: string, index: number, ext: string): string {
  const e = ext.startsWith(".") ? ext : `.${ext}`;
  return `leonardo-${generationId.slice(0, 8)}-${String(index).padStart(2, "0")}${e}`;
}

export function registerLeonardoGenerateCommand(parent: Command): void {
  parent
    .command("generate <prompt>")
    .alias("gen")
    .description("Generate images from a text prompt via Leonardo")
    .option("-m, --model <id>", "Model UUID or GPT-image id")
    .option("-w, --width <n>", "Image width")
    .option("-h, --height <n>", "Image height")
    .option("-n, --num <n>", "Number of images")
    .option("--alchemy", "Enable Alchemy")
    .option("--ultra", "Enable Ultra mode")
    .option("--contrast <n>", "Contrast")
    .option("--style <uuid>", "Style UUID")
    .option("--seed <n>", "Seed")
    .option("--negative <text>", "Negative prompt")
    .option("--enhance", "Enhance prompt")
    .option("--quality <level>", "GPT Image quality: LOW|MEDIUM|HIGH", "HIGH")
    .option("--output <path>", "Copy first image to this path (single-image only)")
    .option("--no-download", "Skip downloading; print URLs only")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "480000")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        prompt: string,
        opts: {
          model?: string;
          width?: string;
          height?: string;
          num?: string;
          alchemy?: boolean;
          ultra?: boolean;
          contrast?: string;
          style?: string;
          seed?: string;
          negative?: string;
          enhance?: boolean;
          quality: string;
          output?: string;
          download: boolean;
          waitTimeout: string;
          verbose?: boolean;
        },
      ) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const client = createLeonardoClient();

        const input: CreateGenerationInput = {
          prompt,
          modelId: opts.model ?? LEONARDO_DEFAULTS.modelId,
          width: opts.width ? Number.parseInt(opts.width, 10) : LEONARDO_DEFAULTS.width,
          height: opts.height ? Number.parseInt(opts.height, 10) : LEONARDO_DEFAULTS.height,
          num_images: opts.num ? Number.parseInt(opts.num, 10) : LEONARDO_DEFAULTS.numImages,
          alchemy: opts.alchemy,
          ultra: opts.ultra,
          contrast: opts.contrast ? Number.parseFloat(opts.contrast) : undefined,
          styleUUID: opts.style,
          seed: opts.seed ? Number.parseInt(opts.seed, 10) : undefined,
          negative_prompt: opts.negative,
          enhancePrompt: opts.enhance,
        };

        logger.info(
          `Submitting generation (${input.width}x${input.height}, n=${input.num_images})`,
        );

        let generationId: string;
        if (isGptImageModel(input.modelId)) {
          const v2Body = {
            public: false,
            model: input.modelId,
            parameters: {
              prompt: input.prompt,
              quantity: input.num_images ?? 1,
              width: input.width,
              height: input.height,
              quality: opts.quality,
              prompt_enhance: input.enhancePrompt ? "ON" : "OFF",
              ...(input.seed !== undefined ? { seed: input.seed } : {}),
            },
          };
          const v2Res = await client.post<CreateV2GenerationResponse>(
            "v2:/generations",
            v2Body,
            logger,
          );
          generationId = v2Res.generate.generationId;
        } else {
          const createRes = await client.post<CreateGenerationResponse>(
            "/generations",
            input,
            logger,
          );
          generationId = createRes.sdGenerationJob.generationId;
        }

        logger.debug(`generationId: ${generationId}`);
        logger.info("Polling for completion...");

        const waitTimeout = Number.parseInt(opts.waitTimeout, 10) || 480_000;
        const intervalMs = 4000;
        const final = await poll<GetGenerationResponse>({
          fetch: () => client.get<GetGenerationResponse>(`/generations/${generationId}`),
          done: (v) =>
            v.generations_by_pk?.status === "COMPLETE" &&
            (v.generations_by_pk?.generated_images?.length ?? 0) > 0,
          failed: (v) => v.generations_by_pk?.status === "FAILED",
          intervalMs,
          maxAttempts: Math.ceil(waitTimeout / intervalMs),
          onTick: (attempt, v) =>
            logger.debug(`attempt ${attempt} — status: ${v.generations_by_pk?.status ?? "?"}`),
        });

        const images = final.generations_by_pk?.generated_images ?? [];

        if (opts.download === false) {
          for (const img of images) console.log(img.url);
          return;
        }

        const outDir = getOutputDir();
        const saved: string[] = [];
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          if (!img) continue;
          const ext = extFromUrl(img.url);
          const filename = autoFilename(generationId, i + 1, ext);
          const filepath = path.join(outDir, filename);
          try {
            await downloadFile(img.url, filepath);
            saved.push(filepath);
            logger.success(`Saved ${filepath}`);
          } catch (e) {
            logger.warn(`Download failed for ${img.id}: ${e instanceof Error ? e.message : e}`);
          }
        }

        if (opts.output && saved[0]) {
          const dest = path.resolve(opts.output);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(saved[0], dest);
          logger.success(`Copied to ${dest}`);
        }

        console.log(`\nGenerated ${saved.length} image(s):`);
        for (const f of saved) console.log(`  ${f}`);
      },
    );
}
