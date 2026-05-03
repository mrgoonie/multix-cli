/**
 * multix byteplus image-to-video <image> — Seedance 2.0 i2v (alias: i2v).
 */

import path from "node:path";
import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { PollFailedError, PollTimeoutError } from "../../leonardo/poll.js";
import { createBytePlusClient } from "../client.js";
import {
  buildVideoTaskBody,
  downloadVideo,
  submitVideoTask,
  waitForVideoTask,
} from "../generators/video.js";
import { resolveImageInput } from "../image-input.js";
import { BYTEPLUS_DEFAULTS } from "../models.js";
import type { ResolvedRef } from "../types.js";

export function registerBytePlusImageToVideoCommand(parent: Command): void {
  parent
    .command("image-to-video <image>")
    .alias("i2v")
    .description("Generate a video from an image (URL or local) via BytePlus Seedance 2.0")
    .requiredOption("--prompt <text>", "Motion prompt")
    .option("-m, --model <id>", "Model id", BYTEPLUS_DEFAULTS.videoModel)
    .option("--resolution <r>", "480p|720p|1080p|2k", BYTEPLUS_DEFAULTS.videoResolution)
    .option("--duration <n>", "Duration seconds", String(BYTEPLUS_DEFAULTS.videoDuration))
    .option("--aspect-ratio <r>", "Aspect ratio", BYTEPLUS_DEFAULTS.videoAspectRatio)
    .option("--audio", "Enable audio")
    .option("--no-audio", "Disable audio")
    .option("--seed <n>", "Fixed seed")
    .option("--negative <text>", "Negative prompt")
    .option("--camera-fixed", "Lock camera")
    .option("--last-frame <path>", "Optional last-frame image (URL or local)")
    .option("--async", "Submit task and exit")
    .option("--wait-timeout <ms>", "Poll timeout in ms", "600000")
    .option("--output <path>", "Output MP4 path")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        image: string,
        opts: {
          prompt: string;
          model: string;
          resolution: string;
          duration: string;
          aspectRatio: string;
          audio?: boolean;
          seed?: string;
          negative?: string;
          cameraFixed?: boolean;
          lastFrame?: string;
          async?: boolean;
          waitTimeout: string;
          output?: string;
          verbose?: boolean;
        },
      ) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const client = createBytePlusClient();

        const first = await resolveImageInput(image, logger);
        const refs: ResolvedRef[] = [];
        if (opts.lastFrame) {
          const last = await resolveImageInput(opts.lastFrame, logger);
          refs.push({
            kind: "image",
            url: last.kind === "url" ? last.url : last.dataUrl,
            mime: last.kind === "data" ? last.mime : undefined,
            role: "last_frame",
          });
        }

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
          imageInputs: [first],
          references: refs,
        });

        logger.info(`Submitting i2v task (${opts.model})`);
        const submitted = await submitVideoTask(client, body, logger);
        const taskId = submitted.id;

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
            logger.error(`Task succeeded but no video_url: ${JSON.stringify(final)}`);
            process.exit(1);
          }
          const outPath =
            opts.output ??
            path.join(getOutputDir(), `byteplus-i2v-${taskId.slice(0, 8)}-${Date.now()}.mp4`);
          await downloadVideo(url, outPath, logger);
          console.log(`\nTask: ${taskId}`);
          console.log(`Saved: ${outPath}`);
        } catch (e) {
          if (e instanceof PollTimeoutError) {
            logger.error(`Timed out — multix byteplus status ${taskId}`);
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
