/**
 * Optimize a video file using ffmpeg.
 * Mirrors optimize_video() from media_optimizer.py.
 */

import { ValidationError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import { assertFfmpeg, getMediaInfo, runFfmpeg } from "./ffmpeg-runner.js";

export interface OptimizeVideoOptions {
  input: string;
  output: string;
  targetSizeMb?: number;
  quality?: number; // CRF value (0-51, lower=better, default 23)
  resolution?: string; // e.g. "1920x1080"
  maxWidth?: number; // default 1920
  verbose?: boolean;
  logger?: Logger;
}

/** Optimize a video file. Resolves true on success, throws on failure. */
export async function optimizeVideo(opts: OptimizeVideoOptions): Promise<void> {
  await assertFfmpeg();

  const {
    input,
    output,
    targetSizeMb,
    quality = 23,
    resolution,
    maxWidth = 1920,
    verbose,
    logger,
  } = opts;

  const info = await getMediaInfo(input);
  if (!info.duration) throw new ValidationError(`Cannot read media info from: ${input}`);

  if (verbose && logger) {
    logger.info(`Input: ${input}`);
    logger.info(`  Size: ${((info.sizeByes ?? 0) / 1024 / 1024).toFixed(2)} MB`);
    logger.info(`  Duration: ${(info.duration ?? 0).toFixed(2)}s`);
    if (info.width) logger.info(`  Resolution: ${info.width}x${info.height}`);
    logger.info(`  Bitrate: ${((info.bitRate ?? 0) / 1000).toFixed(0)} kbps`);
  }

  const args: string[] = ["-i", input, "-y"];

  // Video codec
  args.push("-c:v", "libx264", "-crf", String(quality));

  // Resolution filter
  if (resolution) {
    args.push("-vf", `scale=${resolution}`);
  } else if ((info.width ?? 0) > maxWidth) {
    args.push("-vf", "scale=1920:-2");
  }

  // Audio
  args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");

  // Target size → compute bitrate
  if (targetSizeMb && info.duration) {
    const targetBits = targetSizeMb * 8 * 1024 * 1024;
    const targetBitrate = Math.floor(targetBits / info.duration);
    const videoBitrate = Math.max(targetBitrate - 128_000, 500_000);
    args.push("-b:v", String(videoBitrate));
  }

  args.push(output);

  await runFfmpeg(args, { verbose, logger });
  logger?.success(`Optimized: ${output}`);
}
