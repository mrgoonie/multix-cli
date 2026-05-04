/**
 * multix leonardo image-to-video <imageId> — generate a video from an existing image.
 *
 * Required: imageId, --prompt, --image-type (GENERATED|UPLOADED, default GENERATED).
 *
 * v1 endpoint: POST /generations-image-to-video
 *   Required body: prompt, imageId, imageType
 *   Optional: model, resolution, duration, frameInterpolation, promptEnhance, seed, negativePrompt
 *
 * Async — prints the generationId; poll with `multix leonardo status <id>`.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { createLeonardoClient } from "../client.js";
import { LEONARDO_DEFAULTS } from "../models.js";
import type { CreateVideoResponse } from "../types.js";
import { _leonardoPollAndDownload } from "./video.js";

type ImageType = "GENERATED" | "UPLOADED";

export function registerLeonardoImageToVideoCommand(parent: Command): void {
  parent
    .command("image-to-video <imageId>")
    .alias("i2v")
    .description("Generate a video from an existing Leonardo image (image-to-video)")
    .requiredOption("--prompt <text>", "Motion / scene prompt for the video")
    .option("--image-type <type>", "GENERATED | UPLOADED", "GENERATED")
    .option("--model <model>", "Video model (e.g. MOTION2, VEO3, KLING2_5)")
    .option(
      "--resolution <r>",
      "Resolution (RESOLUTION_480|RESOLUTION_720|RESOLUTION_1080)",
      "RESOLUTION_720",
    )
    .option("--duration <n>", "Duration seconds (model-dependent: 4|5|6|8|10)")
    .option("--seed <n>", "Fixed seed")
    .option("--negative <text>", "Negative prompt")
    .option("--enhance", "Enable prompt enhance")
    .option("--frame-interpolation", "Enable frame interpolation")
    .option("--wait", "Poll until COMPLETE/FAILED instead of returning the job id")
    .option("--wait-timeout <ms>", "Poll timeout in ms (with --wait)", "600000")
    .option("--download", "Download the generated video on success (implies --wait)")
    .option("--output <path>", "Output MP4 path (with --download)")
    .option("--no-thumb", "Skip downloading the thumbnail if the API returns one")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        imageId: string,
        opts: {
          prompt: string;
          imageType: string;
          model?: string;
          resolution: string;
          duration?: string;
          seed?: string;
          negative?: string;
          enhance?: boolean;
          frameInterpolation?: boolean;
          wait?: boolean;
          waitTimeout: string;
          download?: boolean;
          output?: string;
          thumb?: boolean;
          verbose?: boolean;
        },
      ) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const imageType = opts.imageType.toUpperCase() as ImageType;
        if (imageType !== "GENERATED" && imageType !== "UPLOADED") {
          logger.error(`--image-type must be GENERATED or UPLOADED, got '${opts.imageType}'`);
          process.exit(2);
        }

        const model = opts.model ?? LEONARDO_DEFAULTS.videoModel;
        const client = createLeonardoClient();

        logger.info(`Submitting image-to-video (${model}, image=${imageId}, ${imageType})`);

        const body: Record<string, unknown> = {
          prompt: opts.prompt,
          imageId,
          imageType,
          model,
          resolution: opts.resolution,
          promptEnhance: !!opts.enhance,
          frameInterpolation: !!opts.frameInterpolation,
        };
        if (opts.duration) body.duration = Number.parseInt(opts.duration, 10);
        if (opts.seed) body.seed = Number.parseInt(opts.seed, 10);
        if (opts.negative) body.negativePrompt = opts.negative;

        const res = await client.post<CreateVideoResponse>(
          "/generations-image-to-video",
          body,
          logger,
        );
        const jobId = res.motionVideoGenerationJob?.generationId;

        if (!jobId) {
          logger.error(`No generationId returned by Leonardo: ${JSON.stringify(res)}`);
          process.exit(1);
        }

        const shouldWait = !!(opts.wait || opts.download);
        if (!shouldWait) {
          console.log(jobId);
          console.error(`Poll with: multix leonardo status ${jobId}`);
          return;
        }

        await _leonardoPollAndDownload(client, jobId, {
          waitTimeoutMs: Number.parseInt(opts.waitTimeout, 10) || 600_000,
          download: !!opts.download,
          output: opts.output,
          thumb: opts.thumb !== false,
          logger,
          basename: "leonardo-i2v",
        });
      },
    );
}
