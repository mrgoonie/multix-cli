/**
 * multix heygen video-agent <prompt> — prompt-to-video via POST /v3/video-agents.
 * The agent writes the script and picks avatar, voice and scenes. Two-stage
 * job: session_id → video_id → finished video.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import {
  type WaitFlowOptions,
  addWaitOptions,
  collect,
  completeJobs,
  createHeygenClientFromEnv,
  resolveMediaInputs,
} from "../node-helpers.js";
import { buildVideoAgentRequest } from "../request-builders.js";

interface VideoAgentOpts extends WaitFlowOptions {
  avatar?: string;
  voice?: string;
  style?: string;
  brandKit?: string;
  brandGlossary?: string;
  orientation?: string;
  file?: string[];
  callbackUrl?: string;
  callbackId?: string;
}

export function registerHeygenVideoAgentCommand(parent: Command): void {
  const cmd = parent
    .command("video-agent <prompt>")
    .description(
      "Prompt-to-video with HeyGen Video Agent (agent writes the script and picks avatar/voice/scenes)",
    )
    .option("--avatar <look-id>", "Avatar look ID to feature (see `heygen avatars`)")
    .option("--voice <voice-id>", "Narration voice ID (see `heygen voices`)")
    .option("--style <style-id>", "Visual style ID (see `heygen styles`)")
    .option("--brand-kit <id>", "Brand kit ID (colors, fonts, logos)")
    .option("--brand-glossary <id>", "Brand glossary ID (pronunciations)")
    .option("--orientation <o>", "landscape | portrait (auto-detected when omitted)")
    .option(
      "--file <ref>",
      "Attachment: https:// URL, asset:<asset_id>, or local file to upload (repeatable, max 20)",
      collect,
    )
    .option("--callback-url <url>", "HTTPS webhook URL notified on completion/failure")
    .option("--callback-id <id>", "Caller ID echoed in the webhook payload");
  addWaitOptions(cmd).action(async (prompt: string, opts: VideoAgentOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false });
    // Validate locally before uploading attachments or creating a paid session.
    buildVideoAgentRequest({
      prompt,
      orientation: opts.orientation,
      callbackUrl: opts.callbackUrl,
    });
    const client = createHeygenClientFromEnv();
    const files = await resolveMediaInputs(client, opts.file, logger);
    const body = buildVideoAgentRequest({
      prompt,
      avatarId: opts.avatar,
      voiceId: opts.voice,
      styleId: opts.style,
      brandKitId: opts.brandKit,
      brandGlossaryId: opts.brandGlossary,
      orientation: opts.orientation,
      files,
      callbackUrl: opts.callbackUrl,
      callbackId: opts.callbackId,
    });

    logger.info("Creating Video Agent session...");
    const created = await client.createVideoAgent(body);
    logger.debug(`session ${created.session_id} status=${created.status}`);
    await completeJobs(client, "agent", [created.session_id], opts, logger);
  });
}
