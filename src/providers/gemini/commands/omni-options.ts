/**
 * Flags shared by the Gemini Omni video commands, plus the guard that keeps
 * them away from Veo models (which have no equivalent).
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import { videoModelDeprecation } from "../models.js";
import { OMNI_DEFAULT_TIMEOUT_SECONDS, type OmniCommonOptions } from "../omni-run.js";
import { OMNI_ASPECT_RATIOS, OMNI_RESOLUTIONS, OMNI_TASKS } from "../omni.js";

export const OMNI_RESOLUTION_HELP = `Resolution. Omni: ${OMNI_RESOLUTIONS.join("|")} (default 720p; 1080p and 4k are upscaled). Veo: 720p|1080p (default 1080p)`;
export const OMNI_ASPECT_HELP = `Aspect ratio. Omni: ${OMNI_ASPECT_RATIOS.join("|")} (default 16:9). Veo: default 16:9`;

/** Omni-only flags (no default values, so an explicit use can be detected). */
export function addOmniOptions(cmd: Command): Command {
  return cmd
    .option("--delivery <mode>", "Omni: how the video is returned: uri|inline (default uri)")
    .option(
      "--task <task>",
      `Omni: task hint, only if prompting is not enough: ${OMNI_TASKS.join("|")}`,
    )
    .option(
      "--no-store",
      "Omni: do not store the interaction (it cannot be edited or fetched later)",
    )
    .option(
      "--background",
      "Omni: run in the background and poll by interaction id (default unless --no-store)",
    )
    .option(
      "--timeout <seconds>",
      `Omni: overall wait in seconds (default ${OMNI_DEFAULT_TIMEOUT_SECONDS})`,
    );
}

/** Reject Omni-only flags on a Veo model. */
export function rejectOmniFlagsForVeo(opts: OmniCommonOptions): void {
  const used = [
    opts.delivery !== undefined && "--delivery",
    opts.task !== undefined && "--task",
    opts.store === false && "--no-store",
    opts.background === true && "--background",
    opts.timeout !== undefined && "--timeout",
  ].filter(Boolean);
  if (used.length > 0) {
    throw new ValidationError(`${used.join(", ")} only apply to Gemini Omni models`);
  }
}

export function warnIfDeprecated(model: string, logger: Logger): void {
  const warning = videoModelDeprecation(model);
  if (warning) logger.warn(warning);
}
