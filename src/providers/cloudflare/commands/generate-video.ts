import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { createVideoPrediction } from "../client.js";
import { positiveInteger, saveCompletedVideo, waitForVideo } from "./video-helpers.js";

export function registerCloudflareVideoCommand(parent: Command): void {
  parent
    .command("generate-video")
    .description("Create a prunaai/p-video prediction through Cloudflare AI Gateway")
    .requiredOption("--prompt <text>", "Video prompt")
    .option("--duration <seconds>", "Video duration in seconds", "5")
    .option("--aspect-ratio <ratio>", "Aspect ratio", "16:9")
    .option("--resolution <value>", "Resolution", "720p")
    .option("--fps <n>", "Frames per second", "24")
    .option("--wait", "Poll until the prediction succeeds or fails")
    .option("--wait-timeout <ms>", "Polling timeout in ms", "600000")
    .option("--download", "Download the completed video (implies --wait)")
    .option("--output <path>", "Save video at this path")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        prompt: string;
        duration: string;
        aspectRatio: string;
        resolution: string;
        fps: string;
        wait?: boolean;
        waitTimeout: string;
        download?: boolean;
        output?: string;
        verbose?: boolean;
      }) => {
        if (!opts.prompt.trim()) throw new ValidationError("--prompt must not be empty");
        if (!opts.aspectRatio.trim()) throw new ValidationError("--aspect-ratio must not be empty");
        if (!opts.resolution.trim()) throw new ValidationError("--resolution must not be empty");
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const input = {
          prompt: opts.prompt,
          duration: positiveInteger(opts.duration, "--duration"),
          aspect_ratio: opts.aspectRatio,
          resolution: opts.resolution,
          fps: positiveInteger(opts.fps, "--fps"),
        };
        const shouldWait = Boolean(opts.wait || opts.download);
        const prediction = await createVideoPrediction(input, shouldWait);
        logger.success(`Video job ${prediction.id} (${prediction.status})`);

        if (!shouldWait) {
          console.log(prediction.id);
          console.error(`Poll with: multix cloudflare video-status ${prediction.id}`);
          return;
        }

        const completed =
          prediction.status === "succeeded"
            ? prediction
            : await waitForVideo(
                prediction,
                positiveInteger(opts.waitTimeout, "--wait-timeout"),
                (status) => logger.debug(`Video status: ${status}`),
              );
        const destination = await saveCompletedVideo(completed, opts.output);
        logger.success(`Saved ${destination}`);
        console.log(destination);
      },
    );
}
