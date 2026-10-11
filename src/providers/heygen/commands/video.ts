/**
 * multix heygen video [script] — scripted avatar video via POST /v3/videos
 * (`type: "avatar"`). You choose the avatar look, voice and exact script (or
 * supply recorded audio for lip-sync). Other variants (image, cinematic_avatar,
 * studio) are available through `heygen run video --input`.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import {
  type WaitFlowOptions,
  addWaitOptions,
  completeJobs,
  createHeygenClientFromEnv,
  resolveMediaInput,
} from "../node-helpers.js";
import { type AvatarVideoInput, buildAvatarVideoRequest } from "../request-builders.js";
import type { HeygenAssetInput } from "../types.js";

interface VideoOpts extends WaitFlowOptions {
  avatar: string;
  voice?: string;
  audio?: string;
  resolution?: string;
  aspectRatio?: string;
  engine?: string;
  referenceLook?: string;
  motionPrompt?: string;
  expressiveness?: string;
  fit?: string;
  backgroundColor?: string;
  backgroundImage?: string;
  removeBackground?: boolean;
  outputFormat?: string;
  burnCaptions?: boolean;
  speed?: string;
  pitch?: string;
  volume?: string;
  locale?: string;
  title?: string;
  folder?: string;
  brandGlossary?: string;
  callbackUrl?: string;
  callbackId?: string;
}

function toInput(script: string | undefined, opts: VideoOpts): AvatarVideoInput {
  return {
    avatarId: opts.avatar,
    script,
    voiceId: opts.voice,
    resolution: opts.resolution,
    aspectRatio: opts.aspectRatio,
    engine: opts.engine,
    referenceLookId: opts.referenceLook,
    motionPrompt: opts.motionPrompt,
    expressiveness: opts.expressiveness,
    fit: opts.fit,
    backgroundColor: opts.backgroundColor,
    removeBackground: opts.removeBackground,
    outputFormat: opts.outputFormat,
    captions: opts.captions,
    burnCaptions: opts.burnCaptions,
    speed: opts.speed,
    pitch: opts.pitch,
    volume: opts.volume,
    locale: opts.locale,
    title: opts.title,
    folderId: opts.folder,
    brandGlossaryId: opts.brandGlossary,
    callbackUrl: opts.callbackUrl,
    callbackId: opts.callbackId,
  };
}

/** Placeholder used only to validate flag combinations before any upload. */
const PENDING_UPLOAD: HeygenAssetInput = { type: "asset_id", asset_id: "pending" };

export function registerHeygenVideoCommand(parent: Command): void {
  const cmd = parent
    .command("video [script]")
    .description(
      "Scripted avatar video: your avatar look + voice speak your exact script (or lip-sync --audio)",
    )
    .requiredOption("--avatar <look-id>", "Avatar look ID (from `heygen avatars`, not a group ID)")
    .option("--voice <voice-id>", "Voice ID (defaults to the look's default voice)")
    .option(
      "--audio <ref>",
      "Recorded audio instead of a script: https:// URL, asset:<id>, or file",
    )
    .option("--resolution <r>", "4k | 1080p | 720p (4k: Avatar III digital twins/studio avatars)")
    .option("--aspect-ratio <r>", "16:9 | 9:16 | 4:5 | 5:4 | 1:1 | auto", "auto")
    .option("--engine <e>", "avatar_iv (default) | avatar_v | avatar_iii")
    .option("--reference-look <look-id>", "Avatar V animation reference (digital_twin look)")
    .option("--motion-prompt <text>", "Body motion/gesture prompt (photo avatars, or Avatar V)")
    .option("--expressiveness <level>", "high | medium | low (photo avatars, Avatar IV)")
    .option("--fit <f>", "contain | cover")
    .option("--background-color <hex>", "Solid background color, e.g. #ffffff")
    .option("--background-image <ref>", "Background image: https:// URL, asset:<id>, or file")
    .option("--remove-background", "Remove the avatar background (matting-enabled avatars)")
    .option("--output-format <f>", "mp4 (default) | webm (transparent background)")
    .option("--burn-captions", "Burn captions into the video (subtitle file is always produced)")
    .option("--speed <n>", "Voice speed 0.5-1.5")
    .option("--pitch <n>", "Voice pitch -50..50 semitones")
    .option("--volume <n>", "Voice volume 0-1")
    .option("--locale <code>", "Voice locale hint, e.g. en-US")
    .option("--title <text>", "Video title in the HeyGen dashboard")
    .option("--folder <id>", "Destination folder ID")
    .option("--brand-glossary <id>", "Brand glossary ID (pronunciations)")
    .option("--callback-url <url>", "HTTPS webhook URL notified on completion/failure")
    .option("--callback-id <id>", "Caller ID echoed in the webhook payload");
  addWaitOptions(cmd).action(async (script: string | undefined, opts: VideoOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false });
    const input = toInput(script, opts);
    // Validate flag combinations before uploading anything or spending credits.
    buildAvatarVideoRequest({
      ...input,
      audio: opts.audio ? PENDING_UPLOAD : undefined,
      backgroundImage: opts.backgroundImage ? PENDING_UPLOAD : undefined,
    });

    const client = createHeygenClientFromEnv();
    if (opts.audio) input.audio = await resolveMediaInput(client, opts.audio, logger);
    if (opts.backgroundImage) {
      input.backgroundImage = await resolveMediaInput(client, opts.backgroundImage, logger);
    }
    const body = buildAvatarVideoRequest(input);

    logger.info("Submitting avatar video...");
    const created = await client.createVideo(body);
    await completeJobs(client, "video", [created.video_id], opts, logger);
  });
}
