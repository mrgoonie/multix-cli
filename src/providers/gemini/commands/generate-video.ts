/**
 * multix gemini generate-video — generate video via the Gemini API.
 * Default: Gemini Omni Flash (gemini-omni-1.1-flash) over the Interactions API
 * (submit in the background → persist the interaction id → poll → download).
 * An explicit veo-* model keeps the legacy predictLongRunning flow.
 * Requires a paid-tier (billing-enabled) Gemini API key.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { outputStamp } from "../../../core/output-name.js";
import { maybeDownloadThumb } from "../../../core/video-thumb.js";
import { runOmniVideo } from "../omni-flow.js";
import { runVeo, veoFramesFromPaths } from "../veo.js";
import {
  type OmniFlowOpts,
  type VideoFormatOpts,
  addOmniFlowOptions,
  addVideoFormatOptions,
  omniFormat,
  parseWaitTimeout,
  resolveVideoModel,
  veoFormat,
} from "./video-shared.js";

interface GenerateVideoOpts extends VideoFormatOpts, OmniFlowOpts {
  prompt: string;
  model?: string;
  referenceImages?: string[];
  uploadTimeout?: string;
  output?: string;
  thumb?: boolean;
  verbose?: boolean;
}

export function registerGenerateVideoCommand(parent: Command): void {
  const cmd = parent
    .command("generate-video")
    .description("Generate video with Gemini Omni Flash (default) or Veo via the Gemini API")
    .requiredOption("--prompt <text>", "Video generation prompt")
    .option("--model <id>", "Video model: gemini-omni-1.1-flash (default) or veo-*");
  addVideoFormatOptions(cmd, { duration: true });
  cmd.option(
    "--reference-images <paths...>",
    "Images: Omni uses 1-2 as first/last frame or more as subject references; Veo: first=opening, second=closing",
  );
  addOmniFlowOptions(cmd)
    .option("--upload-timeout <ms>", "Deprecated and ignored")
    .option("--output <path>", "Copy generated video to this path")
    .option("--no-thumb", "Skip downloading the thumbnail if the API returns one (Veo only)")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: GenerateVideoOpts) => {
      // With --no-wait, stdout carries only the JSON result.
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: opts.wait === false });
      if (opts.uploadTimeout !== undefined) {
        logger.warn("--upload-timeout is deprecated and ignored");
      }
      const { model, kind } = resolveVideoModel(opts.model);

      if (kind === "omni") {
        const format = omniFormat(opts);
        const result = await runOmniVideo({
          request: { model, prompt: opts.prompt, ...format, store: opts.store !== false },
          imagePaths: opts.referenceImages,
          wait: opts.wait !== false,
          waitTimeoutMs: parseWaitTimeout(opts.waitTimeout),
          output: opts.output,
          logger,
        });
        printOmniResult(result);
        return;
      }

      const format = veoFormat(opts, model, logger);
      logger.debug(`Submitting video generation with ${model}...`);
      logger.info("This may take 30s–6 minutes. Veo requires billing.");

      // First reference image = opening frame, second = closing frame.
      const frames = veoFramesFromPaths(opts.referenceImages);
      const dest = path.join(getOutputDir(), `veo_generated_${outputStamp()}.mp4`);
      const finalOp = await runVeo(
        model,
        { prompt: opts.prompt, ...frames, ...format },
        dest,
        logger,
      );

      logger.success(`Saved video: ${dest}`);

      if (opts.output) {
        fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
        fs.copyFileSync(dest, opts.output);
        logger.success(`Copied to: ${opts.output}`);
      }

      await maybeDownloadThumb(finalOp.response, dest, {
        skip: opts.thumb === false,
        copyTo: opts.output,
        logger,
      });

      console.log(`\nGenerated video: ${dest}`);
    });
}

/** stdout for an Omni run: the video path, or the id to resume with after --no-wait. */
export function printOmniResult(result: {
  interactionId?: string;
  dest?: string;
  recordPath: string;
}): void {
  if (result.dest) {
    console.log(`\nGenerated video: ${result.dest}`);
    if (result.interactionId) console.log(`Interaction ID: ${result.interactionId}`);
    return;
  }
  console.log(
    JSON.stringify(
      { interaction_id: result.interactionId, status: "in_progress", session: result.recordPath },
      null,
      2,
    ),
  );
}
