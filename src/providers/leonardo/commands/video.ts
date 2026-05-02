/**
 * multix leonardo video <prompt> — text-to-video generation.
 *
 * Two endpoints:
 *   - v1 (`/generations-text-to-video`) for enum-style models (MOTION2, VEO3, ...)
 *   - v2 (`/generations`) for string-style models (kling-2.6, hailuo-2_3, ...)
 *
 * The call is async — prints the generationId and suggests `status <id>`.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { createLeonardoClient } from "../client.js";
import { LEONARDO_DEFAULTS, LEONARDO_V2_VIDEO_MODELS } from "../models.js";
import type { CreateV2GenerationResponse, CreateVideoResponse } from "../types.js";

function v2DimsFor(resolution: string): { width: number; height: number } {
  if (resolution === "RESOLUTION_1080") return { width: 1920, height: 1080 };
  if (resolution === "RESOLUTION_480") return { width: 854, height: 480 };
  return { width: 1280, height: 720 };
}

export function registerLeonardoVideoCommand(parent: Command): void {
  parent
    .command("video <prompt>")
    .description("Generate a video from a text prompt via Leonardo (text-to-video)")
    .option("--model <model>", "Video model (e.g. MOTION2, VEO3, kling-2.6)")
    .option(
      "--resolution <r>",
      "Resolution (RESOLUTION_480|RESOLUTION_720|RESOLUTION_1080)",
      "RESOLUTION_720",
    )
    .option("--enhance", "Enable prompt enhance")
    .option("--frame-interpolation", "Enable frame interpolation (v1 only)")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        prompt: string,
        opts: {
          model?: string;
          resolution: string;
          enhance?: boolean;
          frameInterpolation?: boolean;
          verbose?: boolean;
        },
      ) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const model = opts.model ?? LEONARDO_DEFAULTS.videoModel;
        const client = createLeonardoClient();

        logger.info(`Submitting text-to-video (${model})`);

        let jobId: string | undefined;
        if (LEONARDO_V2_VIDEO_MODELS.has(model)) {
          const { width, height } = v2DimsFor(opts.resolution);
          const v2Res = await client.post<CreateV2GenerationResponse>(
            "v2:/generations",
            {
              public: false,
              model,
              parameters: {
                prompt,
                duration: 8,
                mode: opts.resolution,
                prompt_enhance: opts.enhance ? "ON" : "OFF",
                width,
                height,
              },
            },
            logger,
          );
          jobId = v2Res.generate.generationId;
        } else {
          const res = await client.post<CreateVideoResponse>(
            "/generations-text-to-video",
            {
              prompt,
              model,
              resolution: opts.resolution,
              promptEnhance: !!opts.enhance,
              frameInterpolation: !!opts.frameInterpolation,
            },
            logger,
          );
          jobId = res.motionVideoGenerationJob?.generationId;
        }

        if (!jobId) {
          logger.error("No generationId returned by Leonardo");
          process.exit(1);
        }
        console.log(jobId);
        console.error(`Poll with: multix leonardo status ${jobId}`);
      },
    );
}
