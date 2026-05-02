/**
 * Split a long video into fixed-duration chunks using ffmpeg segment muxer.
 * Mirrors split_video() from media_optimizer.py.
 */

import fs from "node:fs";
import path from "node:path";
import { assertFfmpeg, runFfmpeg, getMediaInfo } from "./ffmpeg-runner.js";
import { ValidationError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";

export interface SplitVideoOptions {
  input: string;
  outputDir: string;
  chunkDuration?: number;  // seconds, default 3600
  verbose?: boolean;
  logger?: Logger;
}

/**
 * Split a video into chunks.
 * Returns array of output file paths, or [input] if no split was needed.
 */
export async function splitVideo(opts: SplitVideoOptions): Promise<string[]> {
  await assertFfmpeg();

  const { input, outputDir, chunkDuration = 3600, verbose, logger } = opts;

  const info = await getMediaInfo(input);
  if (!info.duration) throw new ValidationError(`Cannot read media info from: ${input}`);

  const numChunks = Math.ceil(info.duration / chunkDuration);

  if (numChunks <= 1) {
    logger?.info("Video is short enough — no splitting needed");
    return [input];
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const ext = path.extname(input) || ".mp4";
  const baseName = path.basename(input, ext);
  const outputPattern = path.join(outputDir, `${baseName}_chunk_%03d${ext}`);

  logger?.debug(`Splitting into ~${numChunks} chunks of ${chunkDuration}s each`);

  const args = [
    "-i", input, "-y",
    "-f", "segment",
    "-segment_time", String(chunkDuration),
    "-c", "copy",
    "-reset_timestamps", "1",
    outputPattern,
  ];

  await runFfmpeg(args, { verbose, logger });

  // Collect created chunk files
  const files: string[] = [];
  for (let i = 0; i < numChunks + 1; i++) {
    const fname = path.join(outputDir, `${baseName}_chunk_${String(i).padStart(3, "0")}${ext}`);
    if (fs.existsSync(fname)) files.push(fname);
  }

  logger?.success(`Created ${files.length} chunks in ${outputDir}`);
  return files;
}
