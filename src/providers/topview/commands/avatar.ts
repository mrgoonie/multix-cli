/**
 * Avatar tasks on the legacy API (plan credits):
 * - `topview video-avatar`: POST /v1/video_avatar/task/submit;
 * - `topview product-avatar image`: put the product into an avatar's hands
 *   (POST /v3/product_avatar/task/image_replace/submit);
 * - `topview product-avatar video`: animate one of those images
 *   (POST /v3/product_avatar/task/image2Video/submit).
 * File arguments take a local file (uploaded first) or asset:<fileId>.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import {
  createLegacyClientFromEnv,
  createTopviewLogger,
  optionalFile,
  resolveLegacyFile,
} from "./env.js";
import { compact, mergeExtra, oneOf } from "./json-input.js";
import { type TaskCliOpts, addTaskOptions, runLegacyTask } from "./task-runner.js";

const WAIT_MS = 1_800_000;
const AVATAR_SOURCES = ["0", "1", "2", "3"] as const;
const VIDEO_AVATAR_MODES = ["0", "1"] as const;
const PA_IMAGE_MODES = ["auto", "manual"] as const;
const PA_VIDEO_MODES = ["avatar2", "avatar4", "avatar4Fast"] as const;

/** TTS text with a voice, or an audio file: exactly one. */
function scriptSource(opts: { ttsText?: string; audio?: string }): "text" | "audio" {
  if (opts.ttsText !== undefined && opts.audio !== undefined) {
    throw new ValidationError("Use either --tts-text or --audio, not both");
  }
  if (opts.ttsText === undefined && opts.audio === undefined) {
    throw new ValidationError("Provide --tts-text <text> or --audio <pathOrAsset>");
  }
  return opts.audio !== undefined ? "audio" : "text";
}

interface VideoAvatarFlags extends TaskCliOpts {
  avatarSource: string;
  avatarId: string;
  video?: string;
  image?: string;
  ttsText?: string;
  voiceId?: string;
  audio?: string;
  mode?: string;
  captionId?: string;
  voiceSpeed?: string;
  extra?: string;
}

interface ProductImageFlags extends TaskCliOpts {
  product: string;
  avatarId?: string;
  templateImage?: string;
  mode: string;
  prompt?: string;
  extra?: string;
}

interface ProductVideoFlags extends TaskCliOpts {
  imageId: string;
  mode: string;
  ttsText?: string;
  voiceId?: string;
  audio?: string;
  captionId?: string;
  extra?: string;
}

function voiceSpeed(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.8 || n > 1.2) {
    throw new ValidationError(`--voice-speed must be between 0.8 and 1.2 (got "${raw}")`);
  }
  return n;
}

export function registerAvatarCommands(parent: Command): void {
  addTaskOptions(
    parent
      .command("video-avatar")
      .description("Talking avatar video from TTS text or audio (legacy API, plan credits)")
      .requiredOption(
        "--avatar-source <n>",
        "Avatar source: 0 your video, 1 public avatar, 2 custom avatar, 3 image (avatarSourceFrom)",
      )
      .requiredOption("--avatar-id <id>", "AI avatar id (aiAvatarId)")
      .option("--video <pathOrAsset>", "Avatar video (avatar source 0)")
      .option("--image <pathOrAsset>", "Avatar image (avatar source 3)")
      .option("--tts-text <text>", "Script read by the voice (text to speech)")
      .option("--voice-id <id>", "Voice id for --tts-text (voiceoverId)")
      .option("--audio <pathOrAsset>", "Audio file instead of --tts-text")
      .option("--mode <n>", "0 avatar1 (default), 1 avatar2 (modeType)")
      .option("--caption-id <id>", "Caption style id")
      .option("--voice-speed <n>", "0.8-1.2, with --tts-text")
      .option("--extra <json>", "More documented fields as a JSON object or @file.json"),
    WAIT_MS,
  ).action(async (opts: VideoAvatarFlags) => {
    const avatarSourceFrom = oneOf(opts.avatarSource, AVATAR_SOURCES, "--avatar-source");
    const source = scriptSource(opts);
    if (avatarSourceFrom === "0" && opts.video === undefined) {
      throw new ValidationError("--avatar-source 0 needs --video <pathOrAsset>");
    }
    if (avatarSourceFrom === "3" && opts.image === undefined) {
      throw new ValidationError("--avatar-source 3 needs --image <pathOrAsset>");
    }
    const speed = voiceSpeed(opts.voiceSpeed);
    const modeType = oneOf(opts.mode, VIDEO_AVATAR_MODES, "--mode");
    const logger = createTopviewLogger({ verbose: opts.verbose, stdoutReserved: opts.async });
    const client = createLegacyClientFromEnv();
    const body = compact({
      avatarSourceFrom,
      aiAvatarId: opts.avatarId,
      videoFileId: await optionalFile(client, opts.video, logger),
      imageFileId: await optionalFile(client, opts.image, logger),
      audioSourceFrom: source === "audio" ? "0" : "1",
      ttsText: opts.ttsText,
      voiceoverId: opts.voiceId,
      audioFileId: await optionalFile(client, opts.audio, logger),
      voiceSpeed: speed,
      modeType,
      captionId: opts.captionId,
    });
    await runLegacyTask({
      client,
      logger,
      kind: "video-avatar",
      body: mergeExtra(body, opts.extra),
      opts,
      defaultWaitMs: WAIT_MS,
      hint: "video",
    });
  });

  const productAvatar = parent
    .command("product-avatar")
    .description(
      "Product avatar: put a product in an avatar's hands, then animate it (legacy API)",
    );

  addTaskOptions(
    productAvatar
      .command("image")
      .description("Replace the product in an avatar image (step 1, plan credits)")
      .requiredOption(
        "--product <pathOrAsset>",
        "Product image without background (productImageWithoutBackgroundFileId)",
      )
      .option("--avatar-id <id>", "Public product avatar id")
      .option("--template-image <pathOrAsset>", "Your own avatar image instead of --avatar-id")
      .option("--mode <mode>", "auto (uses --prompt) or manual (location in --extra)", "auto")
      .option("--prompt <text>", "Image edit prompt (imageEditPrompt)")
      .option("--extra <json>", "More documented fields as a JSON object or @file.json"),
    WAIT_MS,
  ).action(async (opts: ProductImageFlags) => {
    const mode = oneOf(opts.mode, PA_IMAGE_MODES, "--mode");
    if (opts.avatarId === undefined && opts.templateImage === undefined) {
      throw new ValidationError("Provide --avatar-id <id> or --template-image <pathOrAsset>");
    }
    if (mode === "auto" && !opts.prompt?.trim()) {
      throw new ValidationError("--mode auto needs --prompt <text>");
    }
    const logger = createTopviewLogger({ verbose: opts.verbose, stdoutReserved: opts.async });
    const client = createLegacyClientFromEnv();
    const body = compact({
      generateImageMode: mode,
      avatarId: opts.avatarId,
      templateImageFileId: await optionalFile(client, opts.templateImage, logger),
      productImageWithoutBackgroundFileId: await resolveLegacyFile(client, opts.product, logger),
      imageEditPrompt: opts.prompt,
    });
    await runLegacyTask({
      client,
      logger,
      kind: "product-avatar-image",
      body: mergeExtra(body, opts.extra),
      opts,
      defaultWaitMs: WAIT_MS,
      hint: "image",
    });
  });

  addTaskOptions(
    productAvatar
      .command("video")
      .description("Animate a product avatar image (step 2, plan credits)")
      .requiredOption(
        "--image-id <id>",
        "imageId from `product-avatar image` (replaceProductTaskImageId)",
      )
      .requiredOption("--mode <mode>", `Video mode: ${PA_VIDEO_MODES.join(", ")}`)
      .option("--tts-text <text>", "Script read by --voice-id")
      .option("--voice-id <id>", "Voice id for --tts-text")
      .option("--audio <pathOrAsset>", "Audio file instead of --tts-text")
      .option("--caption-id <id>", "Caption style id")
      .option("--extra <json>", "More documented fields as a JSON object or @file.json"),
    WAIT_MS,
  ).action(async (opts: ProductVideoFlags) => {
    const mode = oneOf(opts.mode, PA_VIDEO_MODES, "--mode");
    const scriptMode = scriptSource(opts);
    if (scriptMode === "text" && !opts.voiceId) {
      throw new ValidationError("--tts-text needs --voice-id <id>");
    }
    const logger = createTopviewLogger({ verbose: opts.verbose, stdoutReserved: opts.async });
    const client = createLegacyClientFromEnv();
    const body = compact({
      replaceProductTaskImageId: opts.imageId,
      mode,
      scriptMode,
      ttsText: opts.ttsText,
      voiceId: opts.voiceId,
      audioFileId: await optionalFile(client, opts.audio, logger),
      captionId: opts.captionId,
    });
    await runLegacyTask({
      client,
      logger,
      kind: "product-avatar-video",
      body: mergeExtra(body, opts.extra),
      opts,
      defaultWaitMs: WAIT_MS,
      hint: "video",
    });
  });
}
