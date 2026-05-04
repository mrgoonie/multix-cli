/**
 * multix gemini image-to-video <imagePath> — generate a video from a starting image with Veo.
 *
 * Thin wrapper around the same Veo pipeline as `gemini generate-video`, with
 * the image as a required positional argument. Optionally accepts a closing
 * frame via --last-frame for Veo 3.1 first/last-frame interpolation.
 *
 * EXPERIMENTAL: Veo endpoints require billing and may change.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { resolveKey } from "../../../core/env-loader.js";
import { ProviderError, ValidationError } from "../../../core/errors.js";
import { downloadFile, httpJson } from "../../../core/http-client.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { maybeDownloadThumb } from "../../../core/video-thumb.js";
import { ASPECT_RATIOS, type AspectRatio, getDefaultModel } from "../models.js";

const BASE = "https://generativelanguage.googleapis.com";

function imagePart(imgPath: string): Record<string, unknown> {
  if (!fs.existsSync(imgPath)) {
    throw new ValidationError(`Image not found: ${imgPath}`);
  }
  const data = fs.readFileSync(imgPath).toString("base64");
  const ext = path.extname(imgPath).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
  return { inlineData: { mimeType, data } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function registerGeminiImageToVideoCommand(parent: Command): void {
  parent
    .command("image-to-video <imagePath>")
    .alias("i2v")
    .description("Generate video from a starting image with Veo (image-to-video) [EXPERIMENTAL]")
    .requiredOption("--prompt <text>", "Motion/scene prompt")
    .option("--last-frame <path>", "Optional closing frame image (Veo 3.1)")
    .option("--model <id>", "Veo model id")
    .option("--resolution <res>", "720p|1080p", "1080p")
    .option("--aspect-ratio <ratio>", "Aspect ratio", "16:9")
    .option("--output <path>", "Copy generated video to this path")
    .option("--no-thumb", "Skip downloading the thumbnail if the API returns one")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        imagePath: string,
        opts: {
          prompt: string;
          lastFrame?: string;
          model?: string;
          resolution: string;
          aspectRatio: string;
          output?: string;
          thumb?: boolean;
          verbose?: boolean;
        },
      ) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });

        const apiKey = resolveKey("GEMINI_API_KEY");
        if (!apiKey) throw new ValidationError("GEMINI_API_KEY is not set");

        const model = opts.model ?? getDefaultModel("generate-video");
        if (!model.startsWith("veo-")) {
          throw new ValidationError(
            `Image-to-video requires a Veo model (got '${model}'). Try veo-3.1-generate-preview.`,
          );
        }

        if (!["720p", "1080p"].includes(opts.resolution)) {
          throw new ValidationError("--resolution must be 720p or 1080p");
        }
        if (!ASPECT_RATIOS.includes(opts.aspectRatio as AspectRatio)) {
          throw new ValidationError(`Invalid aspect ratio: ${opts.aspectRatio}`);
        }

        const contentParts: Array<Record<string, unknown>> = [
          { text: opts.prompt },
          imagePart(imagePath),
        ];
        if (opts.lastFrame) contentParts.push(imagePart(opts.lastFrame));

        const headers = { "x-goog-api-key": apiKey, "Content-Type": "application/json" };

        logger.info(
          "Submitting image-to-video. This may take 30s–6 minutes. Veo requires billing.",
        );

        // biome-ignore lint/suspicious/noExplicitAny: dynamic API
        let operation: any;
        try {
          operation = await httpJson({
            url: `${BASE}/v1beta/models/${model}:generateVideos`,
            method: "POST",
            headers,
            body: {
              contents: [{ parts: contentParts }],
              generationConfig: { aspectRatio: opts.aspectRatio, resolution: opts.resolution },
            },
          });
        } catch (e) {
          throw new ProviderError(
            `Submit failed: ${e instanceof Error ? e.message : String(e)}`,
            "gemini",
          );
        }

        const operationName: string = operation.name;
        logger.debug(`Operation: ${operationName}`);

        const deadline = Date.now() + 10 * 60 * 1000;
        // biome-ignore lint/suspicious/noExplicitAny: dynamic API
        let finalOp: any = operation;
        while (!finalOp.done && Date.now() < deadline) {
          await sleep(10_000);
          finalOp = await httpJson({ url: `${BASE}/v1beta/${operationName}`, headers });
          if (!finalOp.done) {
            logger.debug(`Still generating... ${Math.round((deadline - Date.now()) / 1000)}s left`);
          }
        }

        if (!finalOp.done) throw new ProviderError("Veo timed out after 10 minutes", "gemini");
        if (finalOp.error) {
          throw new ProviderError(`Veo error: ${JSON.stringify(finalOp.error)}`, "gemini");
        }

        const videoUri: string | undefined =
          finalOp.response?.generatedSamples?.[0]?.video?.uri ??
          finalOp.response?.generatedVideos?.[0]?.video?.uri;
        if (!videoUri) {
          throw new ProviderError(
            `Unexpected Veo response: ${JSON.stringify(finalOp.response)}`,
            "gemini",
          );
        }

        const dest = path.join(getOutputDir(), `veo_i2v_${Date.now()}.mp4`);
        await downloadFile(videoUri, dest);
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
      },
    );
}
