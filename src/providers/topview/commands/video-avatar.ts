/**
 * `topview video-avatar` (Legacy API, POST /v1/video_avatar/task/submit):
 * a talking avatar video. Exactly one avatar source and one audio source:
 *
 * | Avatar source          | avatarSourceFrom | Field        |
 * |------------------------|------------------|--------------|
 * | --video <file>         | "0"              | videoFileId  |
 * | --avatar-id <id>       | "1" (public)     | aiAvatarId   |
 * | --avatar-id --custom-avatar | "2" (custom) | aiAvatarId   |
 * | --image <file>         | "3"              | imageFileId  |
 *
 * Audio: --audio <file> (audioSourceFrom "0", audioFileId) or --tts-text
 * (audioSourceFrom "1", ttsText) with --voice-id (required unless the source
 * is a public avatar, which has a default voice) and --voice-speed 0.8-1.2.
 * Async by default; --wait polls and downloads.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { VIDEO_AVATAR_MODE_TYPES, VOICE_SPEED_MAX, VOICE_SPEED_MIN } from "../models.js";
import { createTopviewLegacyClient } from "../node-client.js";
import { type PreparedFile, prepareFileInput, uploadPreparedFile } from "../node-inputs.js";
import {
  type WaitFlagOptions,
  addWaitOptions,
  assertOneOf,
  assertWaitFlags,
  completeLegacyTask,
  nonEmpty,
  parsePositiveInt,
  printLegacyHandle,
} from "./task-flow.js";

export interface VideoAvatarOpts extends WaitFlagOptions {
  video?: string;
  avatarId?: string;
  customAvatar?: boolean;
  image?: string;
  audio?: string;
  ttsText?: string;
  voiceId?: string;
  voiceSpeed?: string;
  modeType?: string;
  captionId?: string;
}

export interface VideoAvatarPlan {
  body: Record<string, unknown>;
  /** Uploads and the body field each fileId goes into. */
  uploads: Array<{ field: string; file: PreparedFile }>;
}

/** Validate every flag before any upload or paid request. */
export function planVideoAvatar(opts: VideoAvatarOpts): VideoAvatarPlan {
  const avatarSources = [opts.video, opts.avatarId, opts.image].filter((v) => v !== undefined);
  if (avatarSources.length !== 1) {
    throw new ValidationError(
      "Pass exactly one avatar source: --video <file>, --avatar-id <id> or --image <file>",
    );
  }
  if (opts.customAvatar && opts.avatarId === undefined) {
    throw new ValidationError("--custom-avatar needs --avatar-id");
  }
  if ((opts.audio === undefined) === (opts.ttsText === undefined)) {
    throw new ValidationError("Pass exactly one audio source: --audio <file> or --tts-text <text>");
  }
  const body: Record<string, unknown> = {};
  const uploads: VideoAvatarPlan["uploads"] = [];
  let source: "0" | "1" | "2" | "3";
  if (opts.video !== undefined) {
    source = "0";
    uploads.push({
      field: "videoFileId",
      file: prepareFileInput(opts.video, "--video", ["video"]),
    });
  } else if (opts.image !== undefined) {
    source = "3";
    uploads.push({
      field: "imageFileId",
      file: prepareFileInput(opts.image, "--image", ["image"]),
    });
  } else {
    source = opts.customAvatar ? "2" : "1";
    body.aiAvatarId = nonEmpty(opts.avatarId, "--avatar-id", 128);
  }
  body.avatarSourceFrom = source;

  const captionId = nonEmpty(opts.captionId, "--caption-id", 128);
  if (captionId) {
    if (source !== "1") {
      throw new ValidationError("--caption-id applies to a public avatar (--avatar-id) only");
    }
    body.captionId = captionId;
  }
  if (opts.modeType !== undefined) {
    body.modeType = assertOneOf(opts.modeType, VIDEO_AVATAR_MODE_TYPES, "--mode-type");
  }

  const voiceId = nonEmpty(opts.voiceId, "--voice-id", 128);
  if (opts.audio !== undefined) {
    if (voiceId || opts.voiceSpeed !== undefined) {
      throw new ValidationError("--voice-id and --voice-speed apply to --tts-text only");
    }
    body.audioSourceFrom = "0";
    uploads.push({
      field: "audioFileId",
      file: prepareFileInput(opts.audio, "--audio", ["audio"]),
    });
  } else {
    body.audioSourceFrom = "1";
    body.ttsText = nonEmpty(opts.ttsText, "--tts-text", 20_000);
    if (!voiceId && source !== "1") {
      throw new ValidationError(
        "--tts-text needs --voice-id unless the avatar is a public --avatar-id (which has a default voice)",
      );
    }
    if (voiceId) body.voiceoverId = voiceId;
    if (opts.voiceSpeed !== undefined) {
      const speed = Number(opts.voiceSpeed);
      if (!Number.isFinite(speed) || speed < VOICE_SPEED_MIN || speed > VOICE_SPEED_MAX) {
        throw new ValidationError(
          `--voice-speed must be from ${VOICE_SPEED_MIN} to ${VOICE_SPEED_MAX}`,
        );
      }
      body.voiceSpeed = speed;
    }
  }
  return { body, uploads };
}

export function registerTopviewVideoAvatarCommand(parent: Command): void {
  const cmd = parent
    .command("video-avatar")
    .description(
      "Legacy API: talking avatar video from a video, photo or avatar id; prints a task id unless --wait",
    )
    .option("--video <path|url>", "Avatar from your own video (mp4, avi, mov)")
    .option("--avatar-id <id>", "Avatar id from the TopView avatar list (public by default)")
    .option("--custom-avatar", "--avatar-id names one of your custom avatars")
    .option("--image <path|url>", "Avatar from a photo (png, jpg, jpeg, bmp, webp)")
    .option("--audio <path|url>", "Speech audio (mp3, wav, m4a)")
    .option("--tts-text <text>", "Script to speak with text-to-speech")
    .option("--voice-id <id>", "TTS voice id (required unless --avatar-id is a public avatar)")
    .option(
      "--voice-speed <n>",
      `TTS speed from ${VOICE_SPEED_MIN} to ${VOICE_SPEED_MAX} (default 1)`,
    )
    .option("--mode-type <n>", "0 = Avatar 1 (default), 1 = Avatar 2")
    .option("--caption-id <id>", "Caption style id (public avatar only)");
  addWaitOptions(cmd, 1_800_000).action(async (opts: VideoAvatarOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false });
    assertWaitFlags(opts, "multix topview status video-avatar <taskId> --wait --download");
    const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
    const plan = planVideoAvatar(opts);
    const client = createTopviewLegacyClient();
    const body = { ...plan.body };
    for (const { field, file } of plan.uploads) {
      body[field] = await uploadPreparedFile(client, file, logger);
    }
    logger.info(
      `TopView video avatar: source ${body.avatarSourceFrom}, ${body.audioSourceFrom === "0" ? "audio file" : "text-to-speech"}`,
    );
    const submitted = await client.submitVideoAvatar(body);
    logger.success(`Created TopView video-avatar task ${submitted.taskId}`);
    if (!opts.wait) {
      printLegacyHandle("video-avatar", submitted.taskId);
      return;
    }
    await completeLegacyTask(client, "video-avatar", submitted.taskId, {
      waitTimeoutMs,
      logger,
      download: opts.download !== false,
      rawUrls: opts.download === false,
      output: opts.output,
    });
  });
}
