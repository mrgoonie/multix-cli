/**
 * Optimize an audio file using ffmpeg.
 * Mirrors optimize_audio() from media_optimizer.py.
 */

import { ValidationError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import { assertFfmpeg, getMediaInfo, runFfmpeg } from "./ffmpeg-runner.js";

export interface OptimizeAudioOptions {
  input: string;
  output: string;
  bitrate?: string; // default "64k"
  sampleRate?: number; // default 16000
  verbose?: boolean;
  logger?: Logger;
}

export async function optimizeAudio(opts: OptimizeAudioOptions): Promise<void> {
  await assertFfmpeg();

  const { input, output, bitrate = "64k", sampleRate = 16000, verbose, logger } = opts;

  const info = await getMediaInfo(input);
  if (!info.duration) throw new ValidationError(`Cannot read media info from: ${input}`);

  if (verbose && logger) {
    logger.info(`Input: ${input}`);
    logger.info(`  Size: ${((info.sizeByes ?? 0) / 1024 / 1024).toFixed(2)} MB`);
    logger.info(`  Duration: ${(info.duration ?? 0).toFixed(2)}s`);
  }

  const args = [
    "-i",
    input,
    "-y",
    "-c:a",
    "aac",
    "-b:a",
    bitrate,
    "-ar",
    String(sampleRate),
    "-ac",
    "1", // mono — Gemini uses mono
    output,
  ];

  await runFfmpeg(args, { verbose, logger });
  logger?.success(`Optimized: ${output}`);
}
