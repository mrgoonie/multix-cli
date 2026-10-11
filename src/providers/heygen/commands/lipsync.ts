/**
 * multix heygen lipsync --video <ref> --audio <ref> — replace a video's audio
 * and re-animate lip movements via POST /v3/lipsyncs.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import {
  type WaitFlowOptions,
  addWaitOptions,
  completeJobs,
  createHeygenClientFromEnv,
  resolveMediaInput,
} from "../node-helpers.js";
import { checkCallback, numberInRange, qualityMode } from "../request-builders.js";
import type { CreateLipsyncRequest } from "../types.js";

interface LipsyncOpts extends WaitFlowOptions {
  video: string;
  audio: string;
  mode?: string;
  keepFormat?: boolean;
  dynamicDuration?: boolean;
  disableMusic?: boolean;
  enhanceSpeech?: boolean;
  start?: string;
  end?: string;
  title?: string;
  folder?: string;
  callbackUrl?: string;
  callbackId?: string;
}

export function registerHeygenLipsyncCommand(parent: Command): void {
  const cmd = parent
    .command("lipsync")
    .description(
      "Lip-sync an existing video to new audio (refs: https:// URL, asset:<id>, or file)",
    )
    .requiredOption("--video <ref>", "Source video")
    .requiredOption("--audio <ref>", "Replacement audio")
    .option("--mode <m>", "speed (default) | precision")
    .option("--keep-format", "Preserve source resolution/bitrate")
    .option("--no-dynamic-duration", "Disable dynamic duration adjustment")
    .option("--disable-music", "Remove the background music track")
    .option("--enhance-speech", "Enhance speech quality")
    .option("--start <s>", "Start time in seconds")
    .option("--end <s>", "End time in seconds")
    .option("--title <text>", "Job title")
    .option("--folder <id>", "Destination folder ID")
    .option("--callback-url <url>", "HTTPS webhook URL notified on completion")
    .option("--callback-id <id>", "Caller ID echoed in the webhook payload");
  addWaitOptions(cmd).action(async (opts: LipsyncOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false });
    const mode = qualityMode(opts.mode);
    const start = numberInRange(opts.start, "--start", 0, Number.MAX_SAFE_INTEGER);
    const end = numberInRange(opts.end, "--end", 0, Number.MAX_SAFE_INTEGER);
    if (start !== undefined && end !== undefined && end <= start) {
      throw new ValidationError("--end must be greater than --start");
    }
    const callbackUrl = checkCallback(opts.callbackUrl);

    const client = createHeygenClientFromEnv();
    const body: CreateLipsyncRequest = {
      video: await resolveMediaInput(client, opts.video, logger),
      audio: await resolveMediaInput(client, opts.audio, logger),
    };
    if (mode) body.mode = mode;
    if (opts.keepFormat) body.keep_the_same_format = true;
    if (opts.dynamicDuration === false) body.enable_dynamic_duration = false;
    if (opts.disableMusic) body.disable_music_track = true;
    if (opts.enhanceSpeech) body.enable_speech_enhancement = true;
    if (start !== undefined) body.start_time = start;
    if (end !== undefined) body.end_time = end;
    if (opts.title) body.title = opts.title;
    if (opts.folder) body.folder_id = opts.folder;
    if (callbackUrl) body.callback_url = callbackUrl;
    if (opts.callbackId) body.callback_id = opts.callbackId;

    logger.info("Submitting lipsync...");
    const created = await client.createLipsync(body);
    await completeJobs(client, "lipsync", [created.lipsync_id], opts, logger);
  });
}
