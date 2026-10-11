/**
 * multix atlas video <prompt>     — text-to-video
 * multix atlas image-to-video ... — animate reference image(s)
 */

import type { Command } from "commander";
import { FIELD_CANDIDATES as F, type FieldRequest } from "../model-input.js";
import { ATLAS_DEFAULT_MODELS } from "../models.js";
import { atlasDefaultModel } from "./env.js";
import { runGenerationCommand } from "./generation-command.js";
import { type RunCliOpts, addRefOption, addRunOptions, requireRefs } from "./prediction-runner.js";

const VIDEO_WAIT_MS = 900_000;
// Docs: poll video every ~5s.
const VIDEO_POLL_MS = 5000;

interface VideoFlags extends RunCliOpts {
  model?: string;
  duration?: string;
  resolution?: string;
  aspectRatio?: string;
  negativePrompt?: string;
  seed?: string;
}

function videoRequests(prompt: string | undefined, o: VideoFlags): FieldRequest[] {
  return [
    { flag: "--prompt", value: prompt, candidates: F.prompt },
    { flag: "--duration", value: o.duration, candidates: F.duration },
    { flag: "--resolution", value: o.resolution, candidates: F.resolution },
    { flag: "--aspect-ratio", value: o.aspectRatio, candidates: F.aspectRatio },
    { flag: "--negative-prompt", value: o.negativePrompt, candidates: F.negativePrompt },
    { flag: "--seed", value: o.seed, candidates: F.seed },
  ];
}

function addVideoFlags(cmd: Command): Command {
  return cmd
    .option("--duration <s>", "Duration in seconds (model-dependent values)")
    .option("--resolution <res>", "Resolution, e.g. 480p, 720p, 1080p (model-dependent)")
    .option("--aspect-ratio <ratio>", "Aspect ratio, e.g. 16:9, 9:16 (model-dependent)")
    .option("--negative-prompt <text>", "Negative prompt (model-dependent)")
    .option("--seed <n>", "Seed");
}

export function registerAtlasVideoCommands(parent: Command): void {
  const video = parent
    .command("video <prompt>")
    .description(`Text-to-video via Atlas Cloud (default: ${ATLAS_DEFAULT_MODELS.video})`)
    .option("-m, --model <id>", "Atlas Cloud video model id (env: ATLASCLOUD_VIDEO_MODEL)");
  addVideoFlags(video);
  addRunOptions(video, { waitTimeoutMs: VIDEO_WAIT_MS, video: true }).action(
    async (prompt: string, opts: VideoFlags) => {
      await runGenerationCommand({
        model: opts.model ?? atlasDefaultModel("video"),
        kind: "video",
        requests: () => videoRequests(prompt, opts),
        opts,
        hint: "video",
        defaultWaitTimeoutMs: VIDEO_WAIT_MS,
        pollIntervalMs: VIDEO_POLL_MS,
      });
    },
  );

  const i2v = parent
    .command("image-to-video")
    .description(
      `Animate reference image(s) via Atlas Cloud (default: ${ATLAS_DEFAULT_MODELS.imageToVideo})`,
    )
    .option("--prompt <text>", "Motion / scene prompt");
  addRefOption(i2v, "Reference image; local files are uploaded first; required").option(
    "-m, --model <id>",
    "Atlas Cloud image-to-video model id (env: ATLASCLOUD_IMAGE_TO_VIDEO_MODEL)",
  );
  addVideoFlags(i2v);
  addRunOptions(i2v, { waitTimeoutMs: VIDEO_WAIT_MS, video: true }).action(
    async (opts: VideoFlags & { prompt?: string; ref: string[] }) => {
      await runGenerationCommand({
        model: opts.model ?? atlasDefaultModel("imageToVideo"),
        kind: "video",
        refs: requireRefs(opts.ref),
        requests: (refs) => [
          ...videoRequests(opts.prompt, opts),
          { flag: "--ref", value: refs, candidates: F.primaryImage },
        ],
        opts,
        hint: "video",
        defaultWaitTimeoutMs: VIDEO_WAIT_MS,
        pollIntervalMs: VIDEO_POLL_MS,
      });
    },
  );
}
