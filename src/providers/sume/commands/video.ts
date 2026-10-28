/**
 * multix sume video [prompt] -m <model> — Sume Video Router: text-to-video,
 * image-to-video (--image, --end-image), references, video-to-video
 * (--video) and lipsync (--audio). The model is required (see
 * `multix sume models`). Prints the job id unless --wait.
 */

import type { Command } from "commander";
import { type GenerateOpts, runGenerate } from "./generate.js";
import { collect } from "./image.js";
import { addOutputOptions } from "./job-flow.js";

export function registerSumeVideoCommand(parent: Command): void {
  const cmd = parent
    .command("video [prompt]")
    .description("Generate video via Sume's Video Router; prints a job id unless --wait")
    .option("-m, --model <id>", "Model id (required) from `multix sume models --kind video`")
    .option("--image <path|url>", "First frame (image-to-video, or the face for lipsync)")
    .option("--end-image <path|url>", "Last frame (needs --image)")
    .option("--video <path|url>", "Source video (video-to-video, video lipsync, captions)")
    .option("--audio <path|url>", "Speech audio for lipsync models")
    .option("--reference-image <path|url>", "Reference image (repeatable)", collect)
    .option("--duration <seconds>", "Duration in whole seconds (per model)")
    .option("--resolution <r>", "Resolution, e.g. 720p, 1080p (per model)")
    .option("--aspect-ratio <ratio>", "Aspect ratio, e.g. 16:9, 9:16 (per model)")
    .option("--generate-audio", "Generate a soundtrack (models with audio)")
    .option("--no-generate-audio", "Make a silent clip")
    .option(
      "--input <json>",
      'Extra request fields as a JSON object, e.g. \'{"captions":{"style":"bold"}}\'',
    )
    .option(
      "--idempotency-key <key>",
      "Reuse the key of an earlier submit so it is not charged twice",
    )
    .option("--wait", "Wait for the job to finish, then download the video");
  addOutputOptions(cmd, 1_800_000).action(
    async (prompt: string | undefined, opts: GenerateOpts) => {
      await runGenerate({ router: "video", prompt, opts });
    },
  );
}
