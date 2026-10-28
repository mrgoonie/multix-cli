/**
 * multix topview video-avatar — a talking avatar video (legacy API, credits).
 * POST /v1/video_avatar/task/submit, polled with GET /v1/video_avatar/task/query
 * (https://docs.topview.ai/reference/video_avatar_submit_task).
 *
 * Exactly one avatar source: --video (your video), --photo (your photo), or
 * --avatar-id (a public avatar, or with --custom-avatar one of yours). Exactly
 * one script: --audio or --tts-text. TopView offers no cancel.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { assertLegacyId } from "../models.js";
import { createTopviewClient } from "../node-client.js";
import { precheckLegacyFile, resolveLegacyFile } from "../node-inputs.js";
import type { VideoAvatarSubmitRequest } from "../types.js";
import {
  type WaitFlagOptions,
  addOutputOptions,
  checkWaitFlags,
  completeLegacyTask,
  printTaskHandle,
} from "./task-flow.js";

const TTS_MAX = 5000;

export interface VideoAvatarOpts extends WaitFlagOptions {
  video?: string;
  photo?: string;
  avatarId?: string;
  customAvatar?: boolean;
  saveAvatar?: boolean;
  mode?: string;
  audio?: string;
  ttsText?: string;
  voiceId?: string;
  voiceSpeed?: string;
  captionId?: string;
}

/** Validate the flags and build the request; file flags are resolved to fileIds later. */
export function planVideoAvatar(opts: VideoAvatarOpts): VideoAvatarSubmitRequest {
  const sources = [opts.video, opts.photo, opts.avatarId].filter((v) => v !== undefined);
  if (sources.length !== 1) {
    throw new ValidationError("Pass exactly one avatar source: --video, --photo or --avatar-id");
  }
  if (opts.customAvatar && opts.avatarId === undefined) {
    throw new ValidationError("--custom-avatar needs --avatar-id");
  }
  if ((opts.audio === undefined) === (opts.ttsText === undefined)) {
    throw new ValidationError(
      "Pass exactly one script: --audio <path|fileId> or --tts-text <text>",
    );
  }
  const avatarSourceFrom: VideoAvatarSubmitRequest["avatarSourceFrom"] =
    opts.video !== undefined ? "0" : opts.photo !== undefined ? "3" : opts.customAvatar ? "2" : "1";
  const request: VideoAvatarSubmitRequest = {
    avatarSourceFrom,
    audioSourceFrom: opts.audio !== undefined ? "0" : "1",
  };
  if (opts.video !== undefined) precheckLegacyFile(opts.video, "--video", ["video"]);
  if (opts.photo !== undefined) precheckLegacyFile(opts.photo, "--photo", ["image"]);
  if (opts.avatarId !== undefined) request.aiAvatarId = assertLegacyId(opts.avatarId, "avatar id");
  if (opts.saveAvatar) {
    if (avatarSourceFrom !== "0") throw new ValidationError("--save-avatar needs --video");
    request.isSave2CustomAiAvatar = true;
  }
  if (opts.mode !== undefined) {
    if (opts.mode !== "avatar1" && opts.mode !== "avatar2") {
      throw new ValidationError("--mode must be avatar1 or avatar2");
    }
    request.modeType = opts.mode === "avatar2" ? "1" : "0";
  }
  if (opts.audio !== undefined) {
    precheckLegacyFile(opts.audio, "--audio", ["audio"]);
    if (opts.voiceId !== undefined || opts.voiceSpeed !== undefined) {
      throw new ValidationError("--voice-id and --voice-speed apply to --tts-text only");
    }
  } else {
    const tts = (opts.ttsText ?? "").trim();
    if (!tts) throw new ValidationError("--tts-text must not be empty");
    if (tts.length > TTS_MAX)
      throw new ValidationError(`--tts-text is longer than ${TTS_MAX} characters`);
    request.ttsText = tts;
    if (opts.voiceId !== undefined) {
      request.voiceoverId = assertLegacyId(opts.voiceId, "voice id");
    } else if (avatarSourceFrom !== "1") {
      throw new ValidationError("--tts-text needs --voice-id unless the avatar is a public one");
    }
    if (opts.voiceSpeed !== undefined) {
      const speed = Number(opts.voiceSpeed);
      if (!Number.isFinite(speed) || speed < 0.8 || speed > 1.2) {
        throw new ValidationError("--voice-speed must be from 0.8 to 1.2");
      }
      request.voiceSpeed = speed;
    }
  }
  if (opts.captionId !== undefined) {
    if (avatarSourceFrom !== "1")
      throw new ValidationError("--caption-id works with a public avatar only");
    request.captionId = assertLegacyId(opts.captionId, "caption id");
  }
  return request;
}

export function registerVideoAvatarCommand(parent: Command): void {
  const cmd = parent
    .command("video-avatar")
    .description("Talking avatar video from a video, photo or avatar id (legacy API, credits)")
    .option("--video <path|fileId>", "Your own avatar video (mp4, avi, mov)")
    .option("--photo <path|fileId>", "Your own avatar photo")
    .option("--avatar-id <id>", "A TopView avatar id (public, or yours with --custom-avatar)")
    .option("--custom-avatar", "--avatar-id is one of your custom avatars")
    .option("--save-avatar", "Save the --video avatar for reuse")
    .option("--mode <mode>", "avatar1 (default) or avatar2 (0.4 credits/s, max 28s)")
    .option("--audio <path|fileId>", "Speech audio (mp3, wav, m4a)")
    .option("--tts-text <text>", "Text to speak instead of --audio")
    .option("--voice-id <id>", "Voice for --tts-text (TopView voice list)")
    .option("--voice-speed <n>", "Speech speed for --tts-text, 0.8-1.2")
    .option("--caption-id <id>", "Caption style id (public avatars only)");
  addOutputOptions(cmd, 900_000).action(async (opts: VideoAvatarOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
    const waitTimeoutMs = checkWaitFlags(opts, "video-avatar");
    const request = planVideoAvatar(opts);
    const client = createTopviewClient();
    if (opts.video !== undefined) {
      request.videoFileId = await resolveLegacyFile(opts.video, "--video", client, logger, [
        "video",
      ]);
    }
    if (opts.photo !== undefined) {
      // The reference says "when audioSourceFrom equals 3"; it means avatarSourceFrom.
      request.imageFileId = await resolveLegacyFile(opts.photo, "--photo", client, logger, [
        "image",
      ]);
    }
    if (opts.audio !== undefined) {
      request.audioFileId = await resolveLegacyFile(opts.audio, "--audio", client, logger, [
        "audio",
      ]);
    }
    logger.info("Billed in TopView credits (Avatar 1: 0.02 credits/s; Avatar 2: 0.4 credits/s)");
    const submitted = await client.submit("video-avatar", request);
    logger.success(`Created TopView video-avatar task ${submitted.taskId}`);
    if (!opts.wait) {
      printTaskHandle("video-avatar", submitted.taskId);
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
