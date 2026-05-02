/**
 * Batch optimize all media files in a directory.
 * Mirrors the batch processing section of media_optimizer.py main().
 */

import fs from "node:fs";
import path from "node:path";
import { extToKind, VIDEO_EXTS, AUDIO_EXTS, IMAGE_EXTS } from "./detect-type.js";
import { optimizeVideo } from "./optimize-video.js";
import { optimizeAudio } from "./optimize-audio.js";
import { optimizeImage } from "./optimize-image.js";
import type { Logger } from "../../core/logger.js";

const ALL_EXTS = new Set([...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS]);

export interface BatchOptions {
  inputDir: string;
  outputDir: string;
  quality?: number;
  maxWidth?: number;
  bitrate?: string;
  verbose?: boolean;
  logger?: Logger;
}

export interface BatchResult {
  total: number;
  succeeded: number;
  failed: number;
  errors: Array<{ file: string; error: string }>;
}

/** Process all supported media files in a directory. */
export async function batchOptimize(opts: BatchOptions): Promise<BatchResult> {
  const { inputDir, outputDir, quality = 85, maxWidth = 1920, bitrate = "64k", verbose, logger } = opts;

  fs.mkdirSync(outputDir, { recursive: true });

  const entries = fs.readdirSync(inputDir);
  const mediaFiles = entries.filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return ALL_EXTS.has(ext);
  });

  if (mediaFiles.length === 0) {
    logger?.warn(`No supported media files found in ${inputDir}`);
    return { total: 0, succeeded: 0, failed: 0, errors: [] };
  }

  logger?.info(`Found ${mediaFiles.length} files to process`);

  let succeeded = 0;
  const errors: Array<{ file: string; error: string }> = [];

  for (const file of mediaFiles) {
    const inputPath = path.join(inputDir, file);
    const outputPath = path.join(outputDir, file);
    const ext = path.extname(file).toLowerCase();
    const kind = extToKind(ext);

    logger?.debug(`Processing: ${file}`);

    try {
      if (kind === "video") {
        await optimizeVideo({ input: inputPath, output: outputPath, quality, maxWidth, verbose, logger });
      } else if (kind === "audio") {
        await optimizeAudio({ input: inputPath, output: outputPath, bitrate, verbose, logger });
      } else if (kind === "image") {
        await optimizeImage({ input: inputPath, output: outputPath, maxWidth, quality, verbose, logger });
      }
      succeeded++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger?.error(`Failed: ${file} — ${msg}`);
      errors.push({ file, error: msg });
    }
  }

  return { total: mediaFiles.length, succeeded, failed: errors.length, errors };
}
