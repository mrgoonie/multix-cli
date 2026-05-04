/**
 * multix gemini generate-video — generate video with Veo via Gemini API.
 * EXPERIMENTAL: Veo endpoints require billing and may change.
 * Uses the operations polling pattern (submit → poll until done → download).
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { resolveKey } from "../../../core/env-loader.js";
import { ProviderError, ValidationError } from "../../../core/errors.js";
import { httpJson } from "../../../core/http-client.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { maybeDownloadThumb } from "../../../core/video-thumb.js";
import { ASPECT_RATIOS, type AspectRatio, getDefaultModel } from "../models.js";

const BASE = "https://generativelanguage.googleapis.com";

export function registerGenerateVideoCommand(parent: Command): void {
  parent
    .command("generate-video")
    .description("Generate video with Veo via Gemini API [EXPERIMENTAL]")
    .requiredOption("--prompt <text>", "Video generation prompt")
    .option("--model <id>", "Veo model to use")
    .option("--resolution <res>", "Video resolution: 720p|1080p", "1080p")
    .option("--aspect-ratio <ratio>", "Aspect ratio", "16:9")
    .option(
      "--reference-images <paths...>",
      "Reference images (first=opening frame, second=closing)",
    )
    .option("--upload-timeout <ms>", "Upload timeout in ms", "120000")
    .option("--output <path>", "Copy generated video to this path")
    .option("--no-thumb", "Skip downloading the thumbnail if the API returns one")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        prompt: string;
        model?: string;
        resolution: string;
        aspectRatio: string;
        referenceImages?: string[];
        uploadTimeout: string;
        output?: string;
        thumb?: boolean;
        verbose?: boolean;
      }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });

        const apiKey = resolveKey("GEMINI_API_KEY");
        if (!apiKey) throw new ValidationError("GEMINI_API_KEY is not set");

        const model = opts.model ?? getDefaultModel("generate-video");

        if (!model.startsWith("veo-")) {
          throw new ValidationError(
            `Video generation requires a Veo model (got '${model}'). Use: veo-3.1-generate-preview, veo-3.0-generate-001, etc.`,
          );
        }

        if (!["720p", "1080p"].includes(opts.resolution)) {
          throw new ValidationError("--resolution must be 720p or 1080p");
        }

        if (!ASPECT_RATIOS.includes(opts.aspectRatio as AspectRatio)) {
          throw new ValidationError(`Invalid aspect ratio: ${opts.aspectRatio}`);
        }

        logger.debug(`Submitting video generation with ${model}...`);
        logger.info("This may take 30s–6 minutes. Veo requires billing.");

        // Build request payload
        const config: Record<string, unknown> = {
          aspectRatio: opts.aspectRatio,
          resolution: opts.resolution,
        };

        // Reference images: inline as base64
        const contentParts: Array<Record<string, unknown>> = [{ text: opts.prompt }];

        if (opts.referenceImages?.length) {
          for (const imgPath of opts.referenceImages.slice(0, 2)) {
            if (!fs.existsSync(imgPath))
              throw new ValidationError(`Reference image not found: ${imgPath}`);
            const data = fs.readFileSync(imgPath).toString("base64");
            const ext = path.extname(imgPath).toLowerCase();
            const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
            contentParts.push({ inlineData: { mimeType, data } });
          }
        }

        const headers = { "x-goog-api-key": apiKey, "Content-Type": "application/json" };

        // Submit generation operation
        // biome-ignore lint/suspicious/noExplicitAny: dynamic API
        let operation: any;
        try {
          operation = await httpJson({
            url: `${BASE}/v1beta/models/${model}:generateVideos`,
            method: "POST",
            headers,
            body: {
              contents: [{ parts: contentParts }],
              generationConfig: config,
            },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new ProviderError(`Video generation submit failed: ${msg}`, "gemini");
        }

        const operationName: string = operation.name;
        logger.debug(`Operation: ${operationName}`);

        // Poll operation until done (max 10 min)
        const deadline = Date.now() + 10 * 60 * 1000;
        let done = false;
        // biome-ignore lint/suspicious/noExplicitAny: dynamic API
        let finalOp: any = operation;

        while (!done && Date.now() < deadline) {
          await sleep(10_000);
          finalOp = await httpJson({
            url: `${BASE}/v1beta/${operationName}`,
            headers,
          });
          done = finalOp.done === true;
          if (!done)
            logger.debug(
              `Still generating... (${Math.round((deadline - Date.now()) / 1000)}s left)`,
            );
        }

        if (!done) throw new ProviderError("Video generation timed out after 10 minutes", "gemini");
        if (finalOp.error)
          throw new ProviderError(`Veo error: ${JSON.stringify(finalOp.error)}`, "gemini");

        // Extract video URI from operation response
        const videoUri: string | undefined =
          finalOp.response?.generatedSamples?.[0]?.video?.uri ??
          finalOp.response?.generatedVideos?.[0]?.video?.uri;

        if (!videoUri) {
          throw new ProviderError(
            `Unexpected Veo response structure: ${JSON.stringify(finalOp.response)}`,
            "gemini",
          );
        }

        const outDir = getOutputDir();
        const dest = path.join(outDir, `veo_generated_${Date.now()}.mp4`);
        const { downloadFile } = await import("../../../core/http-client.js");
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
