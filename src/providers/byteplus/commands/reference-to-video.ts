/**
 * multix byteplus reference-to-video — multimodal video gen with up to 12 refs
 * (≤9 images + ≤3 videos + ≤3 audio). Each ref accepts `path:role` syntax.
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
import { BYTEPLUS_DEFAULTS } from "../models.js";
import { REF_LIMITS, resolveRefSpecs, validateRefCounts } from "../reference-input.js";

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

export function registerBytePlusReferenceToVideoCommand(parent: Command): void {
  parent
    .command("reference-to-video")
    .alias("r2v")
    .description(
      `Generate video from multimodal references (≤${REF_LIMITS.image} images, ≤${REF_LIMITS.video} videos, ≤${REF_LIMITS.audio} audio; total ≤${REF_LIMITS.total}). Use path:role syntax (escape literal colons with \\:).`,
    )
    .requiredOption("--prompt <text>", "Text prompt")
    .option(
      "--ref-image <spec>",
      "Image ref (path|url[:role]); repeatable",
      collect,
      [] as string[],
    )
    .option(
      "--ref-video <spec>",
      "Video ref (path|url[:role]); repeatable",
      collect,
      [] as string[],
    )
    .option(
      "--ref-audio <spec>",
      "Audio ref (path|url[:role]); repeatable",
      collect,
      [] as string[],
    )
    .option("-m, --model <id>", "Model id", BYTEPLUS_DEFAULTS.videoModel)
    .option("--resolution <r>", "480p|720p|1080p|2k", BYTEPLUS_DEFAULTS.videoResolution)
    .option("--duration <n>", "Duration seconds", String(BYTEPLUS_DEFAULTS.videoDuration))
    .option("--aspect-ratio <r>", "Aspect ratio", BYTEPLUS_DEFAULTS.videoAspectRatio)
    .option("--audio", "Enable audio")
    .option("--no-audio", "Disable audio")
    .option("--seed <n>", "Fixed seed")
    .option("--negative <text>", "Negative prompt")
    .option("--camera-fixed", "Lock camera")
    .option("--async", "Submit task and exit")
    .option("--wait-timeout <ms>", "Poll timeout in ms", "600000")
    .option("--output <path>", "Output MP4 path")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        prompt: string;
        refImage: string[];
        refVideo: string[];
        refAudio: string[];
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
        verbose?: boolean;
      }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });

        const specs = [
          ...opts.refImage.map((s) => ({ kind: "image" as const, spec: s })),
          ...opts.refVideo.map((s) => ({ kind: "video" as const, spec: s })),
          ...opts.refAudio.map((s) => ({ kind: "audio" as const, spec: s })),
        ];
        if (specs.length === 0) {
          logger.error("At least one --ref-image / --ref-video / --ref-audio is required");
          process.exit(2);
        }

        const refs = await resolveRefSpecs(specs, logger);
        validateRefCounts(refs);

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
          references: refs,
        });

        logger.info(`Submitting r2v task (${opts.model}, ${refs.length} refs)`);
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
            path.join(getOutputDir(), `byteplus-r2v-${taskId.slice(0, 8)}-${Date.now()}.mp4`);
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
