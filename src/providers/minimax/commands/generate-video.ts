/**
 * multix minimax generate-video — generate video with MiniMax Hailuo models.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { requireMinimaxKey } from "../client.js";
import { generateMinimaxVideo } from "../generators/video.js";
import {
  MINIMAX_VIDEO_MODELS,
  TASK_DEFAULTS,
  VIDEO_DURATIONS,
  VIDEO_RESOLUTIONS,
} from "../models.js";

export function registerMinimaxGenerateVideoCommand(parent: Command): void {
  parent
    .command("generate-video")
    .description("Generate video with MiniMax Hailuo models (async)")
    .requiredOption("--prompt <text>", "Video generation prompt")
    .option("--model <id>", `Model (${[...MINIMAX_VIDEO_MODELS].join("|")})`)
    .option("--duration <n>", `Duration in seconds (${VIDEO_DURATIONS.join("|")})`, "6")
    .option("--resolution <res>", `Resolution (${VIDEO_RESOLUTIONS.join("|")})`, "1080P")
    .option("--first-frame <url>", "First frame image URL")
    .option("--output <path>", "Copy generated video to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        prompt: string;
        model?: string;
        duration: string;
        resolution: string;
        firstFrame?: string;
        output?: string;
        verbose?: boolean;
      }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const apiKey = requireMinimaxKey();
        const model = opts.model ?? TASK_DEFAULTS.video;
        const duration = Number.parseInt(opts.duration, 10);

        if (!VIDEO_DURATIONS.includes(duration as 6 | 10)) {
          throw new ValidationError(`--duration must be one of: ${VIDEO_DURATIONS.join(", ")}`);
        }

        const resolution = opts.resolution.toUpperCase();
        if (!VIDEO_RESOLUTIONS.includes(resolution as "720P" | "1080P")) {
          throw new ValidationError(`--resolution must be one of: ${VIDEO_RESOLUTIONS.join(", ")}`);
        }

        // Validate first-frame URL
        if (opts.firstFrame && !opts.firstFrame.startsWith("http")) {
          throw new ValidationError("--first-frame must be an http(s) URL");
        }

        logger.info("Video generation is async and may take several minutes...");

        const result = await generateMinimaxVideo({
          apiKey,
          prompt: opts.prompt,
          model,
          duration: duration as 6 | 10,
          resolution,
          firstFrame: opts.firstFrame,
          output: opts.output,
          logger,
        });

        if (result.status === "error") {
          logger.error(result.error ?? "Unknown error");
          process.exit(1);
        }

        console.log(`\nGenerated video: ${result.generatedVideo}`);
        if (result.generationTime)
          console.log(`Generation time: ${result.generationTime.toFixed(1)}s`);
        if (result.fileSizeMb) console.log(`File size: ${result.fileSizeMb.toFixed(2)} MB`);
      },
    );
}
