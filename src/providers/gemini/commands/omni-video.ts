/**
 * multix gemini omni-video — kept for scripts written against the 0.1.0 beta.
 * It runs the same Omni pipeline as generate-video / edit-video: --image
 * becomes reference images, --video an uploaded clip to edit, and
 * --previous-interaction-id continues a stored interaction. The run writes a
 * session record (*.interaction.json) instead of the old <video>.json sidecar.
 */

import path from "node:path";
import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { assertInteractionId } from "../client.js";
import { GEMINI_OMNI_MODEL_DEFAULT } from "../models.js";
import { omniSettings, runOmni } from "../omni-run.js";
import { copyToOutput } from "./generate-video.js";

interface OmniVideoOptions {
  prompt: string;
  image?: string[];
  video?: string;
  previousInteractionId?: string;
  uploadTimeout?: string;
  output?: string;
  verbose?: boolean;
}

export function registerOmniVideoCommand(parent: Command): void {
  parent
    .command("omni-video")
    .description(
      "Generate or edit video with Gemini Omni Flash (beta alias; prefer generate-video / edit-video)",
    )
    .requiredOption("--prompt <text>", "Video prompt or concise edit instruction")
    .option("--image <paths...>", "Local image guidance files")
    .option("--video <path>", "One local video to edit (not available in EEA/CH/UK)")
    .option("--previous-interaction-id <id>", "Continue a prior Gemini-stored interaction")
    .option("--upload-timeout <ms>", "Ignored; kept for compatibility")
    .option("--output <path>", "Copy generated video to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: OmniVideoOptions) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      if (opts.video && opts.image?.length) {
        throw new ValidationError("Use either --video or --image guidance, not both.");
      }
      logger.warn(
        "omni-video is kept for compatibility; use generate-video, edit-video or extend-video.",
      );
      const dest = path.join(getOutputDir(), `gemini_omni_${Date.now()}.mp4`);
      const { sessionPath } = await runOmni({
        model: GEMINI_OMNI_MODEL_DEFAULT,
        prompt: opts.prompt,
        settings: omniSettings({}),
        imagePaths: opts.image,
        videoPath: opts.video,
        previousInteractionId: opts.previousInteractionId
          ? assertInteractionId(opts.previousInteractionId)
          : undefined,
        dest,
        logger,
        command: "gemini omni-video",
      });
      copyToOutput(dest, opts.output, logger);
      logger.info(`Session: ${sessionPath}`);
      console.log(`\nGenerated video: ${dest}`);
    });
}
