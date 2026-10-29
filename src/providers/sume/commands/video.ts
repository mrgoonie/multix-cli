/**
 * multix sume video [prompt] -m <id> — text-to-video, first/end frame,
 * reference images, video-to-video and lip-sync, as the chosen model's
 * catalog row allows. Every flag is checked against that row before anything
 * is uploaded or billed. Prints a job id unless --wait.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { SUME_VIDEO_MODEL_ENV } from "../models.js";
import { type GenerateOptions, addOutputOptions, collect, runGeneration } from "./job-flow.js";

export function registerSumeVideoCommand(parent: Command): void {
  const cmd = parent
    .command("video [prompt]")
    .description("Generate video via Sume (also lip-sync, captions); prints a job id unless --wait")
    .option(
      "-m, --model <id>",
      `Model id from \`multix sume models --kind video\` (or ${SUME_VIDEO_MODEL_ENV})`,
    )
    .option("--image <path|url>", "First-frame image (image-to-video, image lip-sync)", collect)
    .option("--end-image <path|url>", "End-frame image (needs --image)")
    .option("--reference-image <path|url>", "Reference image (repeatable)", collect)
    .option("--video <path|url>", "Source video (video-to-video, video lip-sync, captions)")
    .option("--audio <path|url>", "Audio track for lip-sync models")
    .option("--duration <seconds>", "Duration in whole seconds (lip-sync: the audio's length)")
    .option("--resolution <resolution>", "Resolution the model lists, e.g. 720p")
    .option("--aspect-ratio <ratio>", "Aspect ratio the model lists, e.g. 16:9")
    .option("--generate-audio", "Make a soundtrack (models with audio)")
    .option("--no-generate-audio", "Make no soundtrack (models with audio)")
    .option("--param <key=value>", "Another request field the model lists (repeatable)", collect)
    .option("--idempotency-key <key>", "Reuse a key to get back a job an interrupted run created")
    .option("--wait", "Wait for the job to finish, then download the video");
  addOutputOptions(cmd, 900_000).action(
    async (prompt: string | undefined, opts: GenerateOptions) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      await runGeneration("video", prompt, opts, logger);
    },
  );
}
