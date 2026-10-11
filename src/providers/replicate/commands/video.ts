/**
 * multix replicate video <prompt> — text-to-video, or image-to-video with
 * --image, via a Replicate model (default: prunaai/p-video; override with -m
 * or REPLICATE_VIDEO_MODEL). `--input` merges other model-specific fields.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { parseJsonInput } from "../../../core/json-input.js";
import { createLogger } from "../../../core/logger.js";
import { parseModelRef } from "../models.js";
import { createReplicateClient, replicateVideoModel } from "../node-client.js";
import { resolveFileInput } from "../node-input-files.js";
import { parseSeed } from "./image.js";
import {
  type FlowOptions,
  addFlowOptions,
  executePrediction,
  parsePositiveInt,
} from "./prediction-flow.js";

const ASPECT_RE = /^\d{1,2}:\d{1,2}$/;
const RESOLUTION_RE = /^\d{3,4}p$/;

interface VideoOpts extends FlowOptions {
  model?: string;
  image?: string;
  imageKey: string;
  duration?: string;
  aspectRatio?: string;
  resolution?: string;
  seed?: string;
  input?: string;
}

/** Build and validate the model input (without the image, which may need uploading). */
export function buildVideoInput(prompt: string, opts: VideoOpts): Record<string, unknown> {
  if (!prompt.trim()) throw new ValidationError("Prompt must not be empty");
  if (opts.aspectRatio && !ASPECT_RE.test(opts.aspectRatio)) {
    throw new ValidationError("--aspect-ratio must look like 16:9");
  }
  if (opts.resolution && !RESOLUTION_RE.test(opts.resolution)) {
    throw new ValidationError("--resolution must look like 720p");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.imageKey)) {
    throw new ValidationError("--image-key must be an input field name such as image");
  }
  const extra = opts.input ? parseJsonInput(opts.input) : {};
  return {
    ...extra,
    prompt,
    ...(opts.duration ? { duration: parsePositiveInt(opts.duration, "--duration", 60) } : {}),
    ...(opts.aspectRatio ? { aspect_ratio: opts.aspectRatio } : {}),
    ...(opts.resolution ? { resolution: opts.resolution } : {}),
    ...(opts.seed !== undefined ? { seed: parseSeed(opts.seed) } : {}),
  };
}

export function registerReplicateVideoCommand(parent: Command): void {
  const cmd = parent
    .command("video <prompt>")
    .description(`Generate video via Replicate (default: ${replicateVideoModel()})`)
    .option("-m, --model <ref>", "Model: owner/name or owner/name:version")
    .option("--image <path|url>", "First-frame image (local files are inlined or uploaded)")
    .option("--image-key <name>", "Input field that receives --image", "image")
    .option("--duration <seconds>", "Duration in seconds (model limits apply)")
    .option("--aspect-ratio <ratio>", "Aspect ratio, e.g. 16:9, 9:16")
    .option("--resolution <res>", "Resolution, e.g. 720p, 1080p")
    .option("--seed <n>", "Seed for reproducible output")
    .option("--input <json>", "Extra model-specific input fields as JSON or @file.json");
  addFlowOptions(cmd, 900_000).action(async (prompt: string, opts: VideoOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false });
    const model = parseModelRef(opts.model ?? replicateVideoModel());
    const input = buildVideoInput(prompt, opts);
    const client = createReplicateClient();
    if (opts.image) input[opts.imageKey] = await resolveFileInput(opts.image, client, logger);
    await executePrediction({ client, model, input, opts, logger });
  });
}
