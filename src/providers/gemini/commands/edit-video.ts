/**
 * multix gemini edit-video / extend-video — follow-up turns with Gemini Omni Flash.
 *
 * The source is either a stored interaction (--interaction-id, sent as
 * previous_interaction_id on the key whose project holds it) or a local video
 * (--video, uploaded to the Files API; at most 10 s, and unavailable in the
 * EEA, Switzerland and the UK). edit-video rewrites the clip; extend-video
 * appends a 3–10 s continuation to its end.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { GEMINI_OMNI_MODEL_DEFAULT, isOmniVideoModel } from "../models.js";
import { runOmniVideo } from "../omni-flow.js";
import type { OmniVideoTask } from "../omni.js";
import { printOmniResult } from "./generate-video.js";
import {
  type OmniFlowOpts,
  type VideoFormatOpts,
  addOmniFlowOptions,
  addVideoFormatOptions,
  omniFormat,
  parseWaitTimeout,
} from "./video-shared.js";

interface FollowUpOpts extends VideoFormatOpts, OmniFlowOpts {
  prompt: string;
  interactionId?: string;
  video?: string;
  referenceImages?: string[];
  model?: string;
  output?: string;
  verbose?: boolean;
}

function registerFollowUp(
  parent: Command,
  spec: { name: string; task: OmniVideoTask; description: string; promptHelp: string },
): void {
  const cmd = parent
    .command(spec.name)
    .description(spec.description)
    .requiredOption("--prompt <text>", spec.promptHelp)
    .option(
      "--interaction-id <id>",
      "Stored Omni interaction to continue (previous_interaction_id)",
    )
    .option("--video <path>", "Local video (at most 10 s) to upload instead of --interaction-id")
    .option("--reference-images <paths...>", "Optional reference images for the change")
    .option("--model <id>", `Gemini Omni model (default ${GEMINI_OMNI_MODEL_DEFAULT})`);
  addVideoFormatOptions(cmd, { duration: spec.task === "extend", followUp: true });
  addOmniFlowOptions(cmd)
    .option("--output <path>", "Copy the resulting video to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: FollowUpOpts) => {
      // With --no-wait, stdout carries only the JSON result.
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: opts.wait === false });
      if (Boolean(opts.interactionId) === Boolean(opts.video)) {
        throw new ValidationError("Pass exactly one of --interaction-id or --video");
      }
      const model = (opts.model ?? GEMINI_OMNI_MODEL_DEFAULT).replace(/^models\//, "");
      if (!isOmniVideoModel(model)) {
        throw new ValidationError(`${spec.name} needs a Gemini Omni model (got '${model}')`);
      }
      // The API answers HTTP 400 to an aspect ratio beside task "extend"; fail before the upload.
      if (spec.task === "extend" && opts.video && opts.aspectRatio) {
        throw new ValidationError(
          "extend-video --video keeps the source aspect ratio; drop --aspect-ratio",
        );
      }
      // Without explicit flags the follow-up keeps the source's own format.
      const format = omniFormat(opts, false);

      const result = await runOmniVideo({
        request: {
          model,
          prompt: opts.prompt,
          ...format,
          task: spec.task,
          previousInteractionId: opts.interactionId,
          store: opts.store !== false,
        },
        videoPath: opts.video,
        imagePaths: opts.referenceImages,
        wait: opts.wait !== false,
        waitTimeoutMs: parseWaitTimeout(opts.waitTimeout),
        output: opts.output,
        logger,
      });
      printOmniResult(result);
    });
}

export function registerGeminiEditVideoCommands(parent: Command): void {
  registerFollowUp(parent, {
    name: "edit-video",
    task: "edit",
    description: "Edit a Gemini Omni video (stored interaction or uploaded clip) with a prompt",
    promptHelp: 'Edit instruction, e.g. "make it night time"',
  });
  registerFollowUp(parent, {
    name: "extend-video",
    task: "extend",
    description: "Extend a Gemini Omni video with a 3-10 s continuation at its end",
    promptHelp: 'What happens next, e.g. "the camera follows the ball out the door"',
  });
}
