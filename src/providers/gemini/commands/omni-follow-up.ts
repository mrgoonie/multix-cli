/**
 * multix gemini edit-video / extend-video — Gemini Omni follow-ups.
 *
 * Source (exactly one):
 * - a stored interaction: --interaction-id, or --session <file> written by an
 *   earlier Omni command (also pins the key, i.e. the Google Cloud project,
 *   that created it); sent as `previous_interaction_id`;
 * - a local video (--video): uploaded to the Files API and sent as a video
 *   part. Uploaded clips must be 10 s or shorter; editing or extending
 *   uploaded videos is unavailable in the EEA, Switzerland and the UK.
 */

import path from "node:path";
import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { assertInteractionId } from "../client.js";
import { getDefaultModel, videoModelFamily } from "../models.js";
import { type OmniCommonOptions, omniSettings, readSessionRecord, runOmni } from "../omni-run.js";
import { copyToOutput } from "./generate-video.js";
import {
  OMNI_ASPECT_HELP,
  OMNI_RESOLUTION_HELP,
  addOmniOptions,
  warnIfDeprecated,
} from "./omni-options.js";

interface FollowUpOptions extends OmniCommonOptions {
  prompt: string;
  interactionId?: string;
  session?: string;
  video?: string;
  referenceImages?: string[];
  keyEnv?: string;
  model?: string;
  output?: string;
  verbose?: boolean;
}

export interface FollowUpSource {
  previousInteractionId?: string;
  videoPath?: string;
  keyEnv?: string;
}

/** Resolve the single source of a follow-up and the key it must use. */
export function resolveFollowUpSource(opts: {
  interactionId?: string;
  session?: string;
  video?: string;
  keyEnv?: string;
}): FollowUpSource {
  const given = [opts.interactionId, opts.session, opts.video].filter((v) => v !== undefined);
  if (given.length !== 1) {
    throw new ValidationError("Pass exactly one of --interaction-id, --session or --video");
  }
  if (opts.video !== undefined) return { videoPath: opts.video, keyEnv: opts.keyEnv };
  if (opts.session !== undefined) {
    const record = readSessionRecord(opts.session);
    if (!record.store) {
      throw new ValidationError(
        `${opts.session} was created with --no-store; it cannot be continued`,
      );
    }
    return {
      previousInteractionId: assertInteractionId(record.interaction_id),
      keyEnv: opts.keyEnv ?? record.key_env,
    };
  }
  return {
    previousInteractionId: assertInteractionId(opts.interactionId ?? ""),
    keyEnv: opts.keyEnv,
  };
}

function registerFollowUp(
  parent: Command,
  spec: { name: "edit-video" | "extend-video"; description: string; prefix: string },
): void {
  const cmd = parent
    .command(spec.name)
    .description(spec.description)
    .requiredOption("--prompt <text>", "What to change or how the video continues")
    .option("--interaction-id <id>", "Continue a stored Omni interaction")
    .option("--session <file>", "Session file (*.interaction.json) from an earlier Omni command")
    .option("--video <path>", "Local video to upload (10 s or shorter)")
    .option(
      "--reference-images <paths...>",
      "Reference images; refer to them in the prompt as <IMAGE_REF_0>, <IMAGE_REF_1>, ...",
    )
    .option(
      "--key-env <name>",
      "Pin the key env var, e.g. GEMINI_API_KEY_2 (default: the session's key, else rotation)",
    )
    .option("--model <id>", "Gemini Omni model (default gemini-omni-1.1-flash)")
    .option("--resolution <res>", OMNI_RESOLUTION_HELP)
    .option("--aspect-ratio <ratio>", OMNI_ASPECT_HELP)
    .option("--output <path>", "Copy the resulting video to this path")
    .option("-v, --verbose", "Verbose logging");
  addOmniOptions(cmd).action(async (opts: FollowUpOptions) => {
    const logger = createLogger({ verbose: opts.verbose ?? false });
    const model = opts.model ?? getDefaultModel("generate-video");
    if (videoModelFamily(model) !== "omni") {
      throw new ValidationError(`${spec.name} needs a Gemini Omni model (got '${model}')`);
    }
    warnIfDeprecated(model, logger);
    const settings = omniSettings(opts);
    const source = resolveFollowUpSource(opts);
    if (source.videoPath) {
      logger.info(
        "Uploaded videos must be 10 s or shorter; editing or extending them is unavailable in the EEA, Switzerland and the UK.",
      );
    }

    const dest = path.join(getOutputDir(), `${spec.prefix}_${Date.now()}.mp4`);
    const { sessionPath } = await runOmni({
      model,
      prompt: opts.prompt,
      settings,
      imagePaths: opts.referenceImages,
      videoPath: source.videoPath,
      previousInteractionId: source.previousInteractionId,
      keyEnv: source.keyEnv,
      dest,
      logger,
      command: `gemini ${spec.name}`,
    });
    copyToOutput(dest, opts.output, logger);
    logger.info(`Session: ${sessionPath}`);
    console.log(`\nGenerated video: ${dest}`);
  });
}

export function registerGeminiOmniFollowUpCommands(parent: Command): void {
  registerFollowUp(parent, {
    name: "edit-video",
    description:
      "Edit a Gemini Omni video (stored interaction or uploaded clip) with a text instruction",
    prefix: "omni_edit",
  });
  registerFollowUp(parent, {
    name: "extend-video",
    description:
      "Extend a Gemini Omni video by 3–10 s (stored interaction or uploaded clip of 10 s or less)",
    prefix: "omni_extend",
  });
}
