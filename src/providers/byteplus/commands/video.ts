/**
 * multix byteplus video — Seedance 2.0 text-to-video (async).
 */

import path from "node:path";
import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { maybeDownloadThumb } from "../../../core/video-thumb.js";
import { PollFailedError, PollTimeoutError } from "../../leonardo/poll.js";
import { createBytePlusClient } from "../client.js";
import {
  buildVideoTaskBody,
  downloadVideo,
  submitVideoTask,
  waitForVideoTask,
} from "../generators/video.js";
import { BYTEPLUS_DEFAULTS } from "../models.js";

export function registerBytePlusVideoCommand(parent: Command): void {
  parent
    .command("video")
    .description("Generate a video from a text prompt via BytePlus Seedance 2.0")
    .requiredOption("--prompt <text>", "Text prompt")
    .option("-m, --model <id>", "Model id", BYTEPLUS_DEFAULTS.videoModel)
    .option("--resolution <r>", "480p|720p|1080p|2k", BYTEPLUS_DEFAULTS.videoResolution)
    .option("--duration <n>", "Duration seconds (4-15)", String(BYTEPLUS_DEFAULTS.videoDuration))
    .option(
      "--aspect-ratio <r>",
      "Aspect ratio (16:9, 9:16, 1:1, ...)",
      BYTEPLUS_DEFAULTS.videoAspectRatio,
    )
    .option("--audio", "Enable audio track")
    .option("--no-audio", "Disable audio track")
    .option("--seed <n>", "Fixed seed")
    .option("--negative <text>", "Negative prompt")
    .option("--camera-fixed", "Lock camera (no motion)")
    .option("--async", "Submit task and exit; print taskId only")
    .option("--wait-timeout <ms>", "Poll timeout in ms", "600000")
    .option("--output <path>", "Output MP4 path")
    .option("--no-thumb", "Skip downloading the thumbnail if the API returns one")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        prompt: string;
        model: string;
        resolution: string;
        duration: string;
        aspectRatio: string;
        audio?: boolean;
        seed?: string;
        negative?: string;
        cameraFixed?: boolean;
        async?: boolean;
        waitTimeout: string;
        output?: string;
        thumb?: boolean;
        verbose?: boolean;
      }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const client = createBytePlusClient();

        const body = buildVideoTaskBody({
          model: opts.model,
          prompt: opts.prompt,
          resolution: opts.resolution,
          duration: Number.parseInt(opts.duration, 10),
          aspectRatio: opts.aspectRatio,
          audio: opts.audio,
          seed: opts.seed ? Number.parseInt(opts.seed, 10) : undefined,
          negativePrompt: opts.negative,
          cameraFixed: opts.cameraFixed,
        });

        logger.info(
          `Submitting Seedance task (${opts.model}, ${opts.resolution}, ${opts.duration}s)`,
        );
        const submitted = await submitVideoTask(client, body, logger);
        const taskId = submitted.id;
        logger.debug(`taskId: ${taskId}`);

        if (opts.async) {
          console.log(taskId);
          console.error(`Poll with: multix byteplus status ${taskId}`);
          return;
        }

        try {
          const final = await waitForVideoTask(client, taskId, {
            waitTimeoutMs: Number.parseInt(opts.waitTimeout, 10) || 600_000,
            logger,
          });
          const url = final.content?.video_url;
          if (!url) {
            logger.error(`Task succeeded but no video_url in response: ${JSON.stringify(final)}`);
            process.exit(1);
          }
          const outPath =
            opts.output ??
            path.join(getOutputDir(), `byteplus-video-${taskId.slice(0, 8)}-${Date.now()}.mp4`);
          await downloadVideo(url, outPath, logger);
          await maybeDownloadThumb(final, outPath, {
            skip: opts.thumb === false,
            copyTo: opts.output,
            logger,
          });
          console.log(`\nTask: ${taskId}`);
          console.log(`Saved: ${outPath}`);
        } catch (e) {
          if (e instanceof PollTimeoutError) {
            logger.error(
              `Polling timed out — try --async to keep the task and check later: multix byteplus status ${taskId}`,
            );
            process.exit(1);
          }
          if (e instanceof PollFailedError) {
            logger.error(`Task failed: ${JSON.stringify(e.value)}`);
            process.exit(1);
          }
          throw e;
        }
      },
    );
}
