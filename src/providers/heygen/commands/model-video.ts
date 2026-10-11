/**
 * multix heygen model-video <prompt> — HeyGen Video model (`heygen-video-1`)
 * via POST /v3/models/videos: a 5-15 s scene with its own audio, generated
 * from a prompt (optionally a first-frame image or reference media). This is
 * not an avatar video; use `heygen video` to animate an avatar from a script.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import {
  type WaitFlowOptions,
  addWaitOptions,
  collect,
  completeJobs,
  createHeygenClientFromEnv,
  resolveMediaInput,
  resolveMediaInputs,
} from "../node-helpers.js";
import { type ModelVideoInput, buildModelVideoRequest } from "../request-builders.js";
import type { HeygenAssetInput } from "../types.js";

interface ModelVideoOpts extends WaitFlowOptions {
  mode?: string;
  image?: string;
  referenceImage?: string[];
  referenceVideo?: string[];
  referenceAudio?: string[];
  duration?: string;
  resolution?: string;
  aspectRatio?: string;
  promptEnhancement?: string;
  seed?: string;
  callbackUrl?: string;
  callbackId?: string;
}

const PENDING: HeygenAssetInput = { type: "asset_id", asset_id: "pending" };
const pending = (refs: string[] | undefined) => (refs ?? []).map(() => PENDING);

export function registerHeygenModelVideoCommand(parent: Command): void {
  const cmd = parent
    .command("model-video <prompt>")
    .description(
      "HeyGen Video model (heygen-video-1): 5-15 s scene with audio from a prompt (not an avatar video)",
    )
    .option("--mode <m>", "text_to_video | image_to_video | reference_to_video (inferred)")
    .option("--image <ref>", "First frame for image_to_video: https:// URL, asset:<id>, or file")
    .option("--reference-image <ref>", "Reference image (repeatable, max 9)", collect)
    .option("--reference-video <ref>", "Reference video (repeatable, max 3)", collect)
    .option("--reference-audio <ref>", "Reference audio (repeatable, max 3)", collect)
    .option("--duration <s>", "Clip length 5-15 seconds")
    .option("--resolution <r>", "480p | 768p | 1080p | 2k")
    .option("--aspect-ratio <r>", "21:9 | 16:9 | 4:3 | 1:1 | 3:4 | 9:16 | adaptive")
    .option("--prompt-enhancement <p>", "turbo | quality | disabled")
    .option("--seed <n>", "Seed for repeatable output")
    .option("--callback-url <url>", "HTTPS webhook URL notified on completion")
    .option("--callback-id <id>", "Caller ID echoed in the webhook payload");
  addWaitOptions(cmd).action(async (prompt: string, opts: ModelVideoOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false });
    const input: ModelVideoInput = {
      prompt,
      mode: opts.mode,
      duration: opts.duration,
      resolution: opts.resolution,
      aspectRatio: opts.aspectRatio,
      promptEnhancement: opts.promptEnhancement,
      seed: opts.seed,
      callbackUrl: opts.callbackUrl,
      callbackId: opts.callbackId,
    };
    // Validate mode/reference combinations before uploading anything.
    buildModelVideoRequest({
      ...input,
      image: opts.image ? PENDING : undefined,
      referenceImages: pending(opts.referenceImage),
      referenceVideos: pending(opts.referenceVideo),
      referenceAudio: pending(opts.referenceAudio),
    });

    const client = createHeygenClientFromEnv();
    if (opts.image) input.image = await resolveMediaInput(client, opts.image, logger);
    input.referenceImages = await resolveMediaInputs(client, opts.referenceImage, logger);
    input.referenceVideos = await resolveMediaInputs(client, opts.referenceVideo, logger);
    input.referenceAudio = await resolveMediaInputs(client, opts.referenceAudio, logger);
    const body = buildModelVideoRequest(input);

    logger.info(`Submitting HeyGen Video (${body.mode})...`);
    const created = await client.createModelVideo(body);
    await completeJobs(client, "model-video", [created.video_id], opts, logger);
  });
}
