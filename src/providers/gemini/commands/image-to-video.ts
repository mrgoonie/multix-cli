/**
 * multix gemini image-to-video <imagePath> — generate a video from a starting image.
 *
 * Default: Gemini Omni Flash with the image (and an optional --last-frame for
 * first/last-frame interpolation) as input parts before the prompt. An
 * explicit veo-* model keeps the legacy Veo first/last-frame request.
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
import { runVeo, veoImageFromFile } from "../veo.js";
import { printOmniResult } from "./generate-video.js";
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

interface ImageToVideoOpts extends VideoFormatOpts, OmniFlowOpts {
  prompt: string;
  lastFrame?: string;
  model?: string;
  output?: string;
  thumb?: boolean;
  verbose?: boolean;
}

export function registerGeminiImageToVideoCommand(parent: Command): void {
  const cmd = parent
    .command("image-to-video <imagePath>")
    .alias("i2v")
    .description("Generate video from a starting image with Gemini Omni Flash (default) or Veo")
    .requiredOption("--prompt <text>", "Motion/scene prompt")
    .option("--last-frame <path>", "Optional closing frame image (first/last-frame interpolation)")
    .option("--model <id>", "Video model: gemini-omni-1.1-flash (default) or veo-*");
  addVideoFormatOptions(cmd, { duration: true });
  addOmniFlowOptions(cmd)
    .option("--output <path>", "Copy generated video to this path")
    .option("--no-thumb", "Skip downloading the thumbnail if the API returns one (Veo only)")
    .option("-v, --verbose", "Verbose logging")
    .action(async (imagePath: string, opts: ImageToVideoOpts) => {
      // With --no-wait, stdout carries only the JSON result.
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: opts.wait === false });
      const { model, kind } = resolveVideoModel(opts.model);

      if (kind === "omni") {
        const format = omniFormat(opts);
        const result = await runOmniVideo({
          request: {
            model,
            prompt: opts.prompt,
            ...format,
            task: "image_to_video",
            store: opts.store !== false,
          },
          imagePaths: opts.lastFrame ? [imagePath, opts.lastFrame] : [imagePath],
          wait: opts.wait !== false,
          waitTimeoutMs: parseWaitTimeout(opts.waitTimeout),
          output: opts.output,
          logger,
        });
        printOmniResult(result);
        return;
      }

      const format = veoFormat(opts, model, logger);
      logger.info("Submitting image-to-video. This may take 30s–6 minutes. Veo requires billing.");

      const dest = path.join(getOutputDir(), `veo_i2v_${outputStamp()}.mp4`);
      const finalOp = await runVeo(
        model,
        {
          prompt: opts.prompt,
          image: veoImageFromFile(imagePath),
          lastFrame: opts.lastFrame ? veoImageFromFile(opts.lastFrame) : undefined,
          ...format,
        },
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
