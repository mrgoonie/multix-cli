/**
 * Shared option handling for the Gemini video commands: model routing
 * (gemini-omni-* → Interactions API, veo-* → predictLongRunning) and the
 * Omni-specific flags (--duration, --no-store, --no-wait, --wait-timeout).
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import {
  GEMINI_OMNI_MODEL_DEFAULT,
  VEO_PREVIEW_SHUTDOWN_DATE,
  getDefaultModel,
  isOmniVideoModel,
  isVeoVideoModel,
} from "../models.js";
import { OMNI_DEFAULT_WAIT_MS } from "../omni-flow.js";
import {
  OMNI_ASPECT_RATIOS,
  OMNI_DEFAULT_ASPECT_RATIO,
  OMNI_DEFAULT_RESOLUTION,
  OMNI_MAX_DURATION_SECONDS,
  OMNI_MIN_DURATION_SECONDS,
  OMNI_RESOLUTIONS,
  type OmniVideoFormat,
  parseOmniDuration,
  validateOmniFormat,
} from "../omni.js";

export const VEO_RESOLUTIONS = ["720p", "1080p"] as const;
export const VEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
const VEO_DEFAULT_RESOLUTION = "1080p";

export interface VideoFormatOpts {
  resolution?: string;
  aspectRatio?: string;
  duration?: string;
}

export interface OmniFlowOpts {
  /** false with --no-store. */
  store?: boolean;
  /** false with --no-wait. */
  wait?: boolean;
  waitTimeout?: string;
}

/**
 * `followUp`: edit/extend keep the source video's format unless a flag is
 * given, so those flags get no defaults and no Veo values.
 */
export function addVideoFormatOptions(
  cmd: Command,
  opts: { duration: boolean; followUp?: boolean },
): Command {
  if (opts.followUp) {
    cmd
      .option("--resolution <res>", `Output resolution: ${OMNI_RESOLUTIONS.join("|")}`)
      .option("--aspect-ratio <ratio>", `Aspect ratio: ${OMNI_ASPECT_RATIOS.join("|")}`);
  } else {
    cmd
      .option(
        "--resolution <res>",
        `Omni: ${OMNI_RESOLUTIONS.join("|")} (default ${OMNI_DEFAULT_RESOLUTION}); Veo: ${VEO_RESOLUTIONS.join("|")} (default ${VEO_DEFAULT_RESOLUTION})`,
      )
      .option(
        "--aspect-ratio <ratio>",
        `Aspect ratio: ${OMNI_ASPECT_RATIOS.join("|")}`,
        OMNI_DEFAULT_ASPECT_RATIO,
      );
  }
  if (opts.duration) {
    cmd.option(
      "--duration <seconds>",
      `Omni only: ${opts.followUp ? "length of the new continuation" : "video length"}, ${OMNI_MIN_DURATION_SECONDS}-${OMNI_MAX_DURATION_SECONDS} seconds (model default when omitted)`,
    );
  }
  return cmd;
}

export function addOmniFlowOptions(cmd: Command): Command {
  return cmd
    .option(
      "--no-store",
      "Omni: one synchronous request that Google does not store (cannot be edited, extended or resumed)",
    )
    .option(
      "--no-wait",
      "Omni: submit, print the interaction id and exit; finish with `gemini video-status <id> --download`",
    )
    .option(
      "--wait-timeout <ms>",
      "Omni: deadline for uploads, submit and polling (saving the video has its own budget)",
      String(OMNI_DEFAULT_WAIT_MS),
    );
}

export function parseWaitTimeout(value: string | undefined): number {
  if (value === undefined) return OMNI_DEFAULT_WAIT_MS;
  const ms = /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(ms) || ms < 1000) {
    throw new ValidationError(
      "--wait-timeout must be a whole number of milliseconds, at least 1000",
    );
  }
  return ms;
}

/**
 * Normalised Omni format options, validated before anything is sent.
 * `defaults: false` leaves unset options unset (the server keeps the source format).
 */
export function omniFormat(opts: VideoFormatOpts, defaults = true): OmniVideoFormat {
  const resolution = opts.resolution ?? (defaults ? OMNI_DEFAULT_RESOLUTION : undefined);
  const format: OmniVideoFormat = {
    aspectRatio: opts.aspectRatio ?? (defaults ? OMNI_DEFAULT_ASPECT_RATIO : undefined),
    resolution: resolution?.toLowerCase(),
    durationSeconds: parseOmniDuration(opts.duration),
  };
  validateOmniFormat(format);
  return format;
}

/** The video model to use; anything that is neither Omni nor Veo is rejected, never re-routed. */
export function resolveVideoModel(model: string | undefined): {
  model: string;
  kind: "omni" | "veo";
} {
  const id = (model ?? getDefaultModel("generate-video")).trim();
  if (isOmniVideoModel(id)) return { model: id.replace(/^models\//, ""), kind: "omni" };
  if (isVeoVideoModel(id)) return { model: id, kind: "veo" };
  throw new ValidationError(
    `Unsupported Gemini video model '${id}'. Use ${GEMINI_OMNI_MODEL_DEFAULT} (default) or a veo-* model.`,
  );
}

/** Veo accepts only the legacy flags; Omni-only flags fail clearly instead of being ignored. */
export function veoFormat(
  opts: VideoFormatOpts & OmniFlowOpts,
  model: string,
  logger: Logger,
): { resolution: string; aspectRatio: string } {
  if (opts.duration !== undefined)
    throw new ValidationError("--duration is supported for Gemini Omni models only");
  if (opts.store === false)
    throw new ValidationError("--no-store is supported for Gemini Omni models only");
  if (opts.wait === false)
    throw new ValidationError("--no-wait is supported for Gemini Omni models only");
  const resolution = opts.resolution ?? VEO_DEFAULT_RESOLUTION;
  if (!(VEO_RESOLUTIONS as readonly string[]).includes(resolution)) {
    throw new ValidationError(`Veo supports --resolution ${VEO_RESOLUTIONS.join(" or ")}`);
  }
  const aspectRatio = opts.aspectRatio ?? "16:9";
  if (!(VEO_ASPECT_RATIOS as readonly string[]).includes(aspectRatio)) {
    throw new ValidationError(`Veo supports --aspect-ratio ${VEO_ASPECT_RATIOS.join(" or ")}`);
  }
  if (/-preview$/.test(model)) {
    logger.warn(
      `${model} shuts down on the Gemini API on ${VEO_PREVIEW_SHUTDOWN_DATE}; use ${GEMINI_OMNI_MODEL_DEFAULT} (the default) instead`,
    );
  }
  return { resolution, aspectRatio };
}
