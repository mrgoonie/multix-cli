/**
 * multix leonardo image-to-image — generate an image conditioned on an existing
 * Leonardo image (init image / image guidance).
 *
 * Required: --ref <imageId> (existing Leonardo image id), --prompt.
 * `--image-type GENERATED|UPLOADED` matches the convention used by `image-to-video`.
 *
 * Async: Leonardo polls the generation endpoint. Reuses --wait/--download/--output
 * pattern from `generate`. To use a local file or URL as init, first upload via
 * Leonardo UI or a future `leonardo upload` command — direct upload from path
 * is not yet supported here.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { downloadFile } from "../../../core/http-client.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { createLeonardoClient } from "../client.js";
import { LEONARDO_DEFAULTS } from "../models.js";
import { poll } from "../poll.js";
import type { CreateGenerationResponse, GetGenerationResponse } from "../types.js";

type ImageType = "GENERATED" | "UPLOADED";

function extFromUrl(url: string, fallback = ".png"): string {
  try {
    return path.extname(new URL(url).pathname) || fallback;
  } catch {
    return fallback;
  }
}

export function registerLeonardoImageToImageCommand(parent: Command): void {
  parent
    .command("image-to-image")
    .alias("i2i")
    .description("Generate an image conditioned on an existing Leonardo image id (init image)")
    .requiredOption("--prompt <text>", "Text prompt describing the desired output")
    .requiredOption("--ref <imageId>", "Existing Leonardo image id to use as init image")
    .option("--image-type <type>", "GENERATED | UPLOADED", "GENERATED")
    .option("--init-strength <n>", "Init image strength (0.0-0.9)", "0.5")
    .option("-m, --model <id>", "Model UUID")
    .option("-w, --width <n>", "Image width")
    .option("-h, --height <n>", "Image height")
    .option("-n, --num <n>", "Number of images")
    .option("--seed <n>", "Seed")
    .option("--negative <text>", "Negative prompt")
    .option("--output <path>", "Copy first image to this path (single-image only)")
    .option("--no-download", "Skip downloading; print URLs only")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "480000")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        prompt: string;
        ref: string;
        imageType: string;
        initStrength: string;
        model?: string;
        width?: string;
        height?: string;
        num?: string;
        seed?: string;
        negative?: string;
        output?: string;
        download: boolean;
        waitTimeout: string;
        verbose?: boolean;
      }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const imageType = opts.imageType.toUpperCase() as ImageType;
        if (imageType !== "GENERATED" && imageType !== "UPLOADED") {
          logger.error(`--image-type must be GENERATED or UPLOADED, got '${opts.imageType}'`);
          process.exit(2);
        }

        const initStrength = Number.parseFloat(opts.initStrength);
        if (Number.isNaN(initStrength) || initStrength < 0 || initStrength > 0.9) {
          logger.error("--init-strength must be a number in [0.0, 0.9]");
          process.exit(2);
        }

        const client = createLeonardoClient();

        const body: Record<string, unknown> = {
          prompt: opts.prompt,
          modelId: opts.model ?? LEONARDO_DEFAULTS.modelId,
          width: opts.width ? Number.parseInt(opts.width, 10) : LEONARDO_DEFAULTS.width,
          height: opts.height ? Number.parseInt(opts.height, 10) : LEONARDO_DEFAULTS.height,
          num_images: opts.num ? Number.parseInt(opts.num, 10) : LEONARDO_DEFAULTS.numImages,
          init_strength: initStrength,
        };

        // Field name depends on whether ref is from a generation or an upload.
        if (imageType === "GENERATED") {
          body.init_generation_image_id = opts.ref;
        } else {
          body.init_image_id = opts.ref;
        }

        if (opts.seed) body.seed = Number.parseInt(opts.seed, 10);
        if (opts.negative) body.negative_prompt = opts.negative;

        logger.info(`Submitting image-to-image (init=${opts.ref}, type=${imageType})`);

        const createRes = await client.post<CreateGenerationResponse>("/generations", body, logger);
        const generationId = createRes.sdGenerationJob.generationId;
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
          const filename = `leonardo-i2i-${generationId.slice(0, 8)}-${String(i + 1).padStart(2, "0")}${ext}`;
          const filepath = path.join(outDir, filename);
          try {
            await downloadFile(img.url, filepath);
            saved.push(filepath);
            logger.success(`Saved ${filepath}`);
          } catch (e) {
            logger.warn(`Download failed: ${e instanceof Error ? e.message : e}`);
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
