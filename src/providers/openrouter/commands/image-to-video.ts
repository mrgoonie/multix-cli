/**
 * multix openrouter image-to-video — submit an image-to-video job to OpenRouter.
 *
 * Async — prints the job id to stdout. Poll with `multix openrouter video-status <id>`.
 *
 * OpenRouter image inputs are URL-only — pass --image-url <https-url>.
 * Optional --last-frame-url for models supporting first/last frame interpolation.
 */

import type { Command } from "commander";
import { resolveKey } from "../../../core/env-loader.js";
import { createLogger } from "../../../core/logger.js";
import { PollFailedError, PollTimeoutError, poll } from "../../leonardo/poll.js";
import { type OpenRouterVideoPollResponse, pollVideoJob, submitVideoJob } from "../video-client.js";
import { downloadOpenRouterVideo } from "./video-status.js";

export function registerOpenRouterImageToVideoCommand(parent: Command): void {
  parent
    .command("image-to-video")
    .alias("i2v")
    .description("Submit an image-to-video job to OpenRouter (async, returns job id)")
    .requiredOption("--prompt <text>", "Motion/scene prompt")
    .requiredOption("--image-url <url>", "First-frame image URL (https)")
    .option("--last-frame-url <url>", "Optional last-frame image URL")
    .option("--model <id>", "OpenRouter video model id (e.g. google/veo-3.1)")
    .option("--resolution <r>", "Resolution hint (e.g. 720p, 1080p)")
    .option("--aspect-ratio <r>", "Aspect ratio hint (e.g. 16:9, 9:16)")
    .option("--duration <n>", "Duration seconds")
    .option("--seed <n>", "Fixed seed")
    .option("--wait", "Poll until status is 'completed' or 'failed'")
    .option("--wait-timeout <ms>", "Poll timeout in ms (with --wait)", "600000")
    .option("--download", "Download the generated video on success (implies --wait)")
    .option("--output <path>", "Copy downloaded video to this path")
    .option("--no-thumb", "Skip downloading the thumbnail if the API returns one")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        prompt: string;
        imageUrl: string;
        lastFrameUrl?: string;
        model?: string;
        resolution?: string;
        aspectRatio?: string;
        duration?: string;
        seed?: string;
        wait?: boolean;
        waitTimeout: string;
        download?: boolean;
        output?: string;
        thumb?: boolean;
        verbose?: boolean;
      }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const model = opts.model ?? resolveKey("OPENROUTER_VIDEO_MODEL") ?? "google/veo-3.1";

        const frame_images: Array<Record<string, unknown>> = [
          {
            type: "image_url",
            image_url: { url: opts.imageUrl },
            frame_type: "first_frame",
          },
        ];
        if (opts.lastFrameUrl) {
          frame_images.push({
            type: "image_url",
            image_url: { url: opts.lastFrameUrl },
            frame_type: "last_frame",
          });
        }

        const body: Record<string, unknown> = {
          model,
          prompt: opts.prompt,
          frame_images,
        };
        if (opts.resolution) body.resolution = opts.resolution;
        if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio;
        if (opts.duration) body.duration = Number.parseInt(opts.duration, 10);
        if (opts.seed) body.seed = Number.parseInt(opts.seed, 10);

        logger.info(`Submitting image-to-video job (model=${model})`);
        const res = await submitVideoJob(body);
        logger.success(`Job ${res.id} (status: ${res.status})`);

        const shouldWait = !!(opts.wait || opts.download);
        if (!shouldWait) {
          console.log(res.id);
          console.error(`Poll with: multix openrouter video-status ${res.id}`);
          return;
        }

        let final: OpenRouterVideoPollResponse;
        try {
          final = await poll<OpenRouterVideoPollResponse>({
            fetch: () => pollVideoJob(res.id),
            done: (v) => v.status === "completed",
            failed: (v) => v.status === "failed",
            intervalMs: 5000,
            maxAttempts: Math.max(
              1,
              Math.ceil((Number.parseInt(opts.waitTimeout, 10) || 600_000) / 5000),
            ),
            onTick: (n, v) => logger.debug(`attempt ${n} — status: ${v.status}`),
          });
        } catch (e) {
          if (e instanceof PollTimeoutError) {
            logger.error(`Timed out — multix openrouter video-status ${res.id}`);
            process.exit(1);
          }
          if (e instanceof PollFailedError) {
            logger.error(`Job failed: ${JSON.stringify(e.value)}`);
            process.exit(1);
          }
          throw e;
        }

        console.error(`status: ${final.status}`);
        for (const u of final.unsigned_urls ?? []) console.log(u);

        if (opts.download) {
          await downloadOpenRouterVideo({
            jobId: res.id,
            output: opts.output,
            thumb: opts.thumb,
            logger,
            source: final,
          });
        }
      },
    );
}
