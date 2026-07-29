/** `multix gemini omni-video` — Gemini Omni Flash generation and editing. */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { uploadFile } from "../client.js";
import {
  createOmniInteraction,
  downloadGeminiFile,
  selectGeminiDownloadUri,
  waitForGeminiFile,
} from "../interactions.js";
import { getMimeType } from "../task-resolver.js";

interface OmniOptions {
  prompt: string;
  image?: string[];
  video?: string;
  previousInteractionId?: string;
  uploadTimeout: string;
  output?: string;
  verbose?: boolean;
}

export function registerOmniVideoCommand(parent: Command): void {
  parent
    .command("omni-video")
    .description("Generate or edit video with Gemini Omni Flash [PAID PREVIEW]")
    .requiredOption("--prompt <text>", "Video prompt or concise edit instruction")
    .option("--image <paths...>", "Local image guidance files")
    .option("--video <path>", "One local video to edit (not available in EEA/CH/UK)")
    .option("--previous-interaction-id <id>", "Continue a prior Gemini-stored interaction")
    .option("--upload-timeout <ms>", "Files API processing timeout in ms", "300000")
    .option("--output <path>", "Copy generated video to this path")
    .option("-v, --verbose", "Verbose logging")
    .addHelpText(
      "after",
      "\nPreview, paid-tier API. Outputs 3-10 second 720p videos. Audio references, video extension/interpolation, voice editing, and multiple videos are unsupported. Follow-up edits require provider-side stored interactions; no local history is kept.",
    )
    .action(async (opts: OmniOptions) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      validateInputs(opts);

      const images = (opts.image ?? []).map(readImage);
      const videoFile = opts.video
        ? await uploadFile(opts.video, { timeoutMs: parseTimeout(opts.uploadTimeout), logger })
        : undefined;
      const result = await createOmniInteraction({
        prompt: opts.prompt,
        images,
        videoFileUri: videoFile?.uri,
        previousInteractionId: opts.previousInteractionId,
      });

      const destination = path.join(getOutputDir(), `gemini_omni_${Date.now()}.mp4`);
      if (result.video.kind === "inline") {
        fs.writeFileSync(destination, Buffer.from(result.video.data, "base64"));
      } else {
        const generated = await waitForGeminiFile(result.video.uri);
        await downloadGeminiFile(selectGeminiDownloadUri(generated, result.video.uri), destination);
      }

      const metadataPath = `${destination}.json`;
      fs.writeFileSync(
        metadataPath,
        `${JSON.stringify(buildOmniVideoMetadata(opts, result.interactionId), null, 2)}\n`,
      );

      if (opts.output) {
        fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
        fs.copyFileSync(destination, opts.output);
        fs.copyFileSync(metadataPath, `${opts.output}.json`);
      }

      logger.success(`Saved video: ${destination}`);
      logger.success(`Saved metadata: ${metadataPath}`);
      if (opts.output) logger.success(`Copied to: ${opts.output}`);
      console.log(`Interaction ID: ${result.interactionId}`);
    });
}

export function buildOmniVideoMetadata(
  opts: Pick<OmniOptions, "prompt" | "image" | "video">,
  interactionId: string,
): Record<string, unknown> {
  return {
    provider: "gemini",
    model: "gemini-omni-flash-preview",
    prompt: opts.prompt,
    inputFiles: [...(opts.image ?? []), ...(opts.video ? [opts.video] : [])].map((filePath) =>
      path.basename(filePath),
    ),
    timestamp: new Date().toISOString(),
    interactionId,
  };
}

function validateInputs(opts: OmniOptions): void {
  if (opts.video && opts.image?.length) {
    throw new ValidationError("Use either --video or --image guidance, not both.");
  }
  if (opts.video) {
    requireLocalFile(opts.video, "video");
    if (!getMimeType(opts.video).startsWith("video/")) {
      throw new ValidationError(`Unsupported video file: ${opts.video}`);
    }
  }
  for (const imagePath of opts.image ?? []) {
    requireLocalFile(imagePath, "image");
    if (!getMimeType(imagePath).startsWith("image/")) {
      throw new ValidationError(`Unsupported image file: ${imagePath}`);
    }
  }
}

function requireLocalFile(filePath: string, label: string): void {
  if (/^https?:\/\//i.test(filePath)) throw new ValidationError(`${label} URLs are not supported.`);
  if (!fs.existsSync(filePath)) throw new ValidationError(`${label} file not found: ${filePath}`);
}

function readImage(filePath: string): { data: string; mimeType: string } {
  return { data: fs.readFileSync(filePath).toString("base64"), mimeType: getMimeType(filePath) };
}

function parseTimeout(value: string): number {
  const timeout = Number.parseInt(value, 10);
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new ValidationError("--upload-timeout must be positive.");
  return timeout;
}
