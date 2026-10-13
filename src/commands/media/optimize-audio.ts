/**
 * Optimize an audio file using ffmpeg.
 * Mirrors optimize_audio() from media_optimizer.py.
 */

import path from "node:path";
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

/** Encoder for each output container; `lossless` codecs take no bitrate. */
const AUDIO_CODECS: Record<string, { codec: string; lossless?: boolean }> = {
  ".mp3": { codec: "libmp3lame" },
  ".m4a": { codec: "aac" },
  ".aac": { codec: "aac" },
  ".mp4": { codec: "aac" },
  ".mka": { codec: "aac" },
  ".ogg": { codec: "libopus" },
  ".opus": { codec: "libopus" },
  ".wav": { codec: "pcm_s16le", lossless: true },
  ".aiff": { codec: "pcm_s16be", lossless: true },
  ".flac": { codec: "flac", lossless: true },
};

/**
 * Builds the ffmpeg arguments for an audio optimization. The codec follows the
 * output extension, since a container such as mp3 cannot hold AAC.
 */
export function buildAudioArgs(opts: {
  input: string;
  output: string;
  bitrate: string;
  sampleRate: number;
}): string[] {
  const ext = path.extname(opts.output).toLowerCase();
  const entry = AUDIO_CODECS[ext];
  if (!entry) {
    throw new ValidationError(
      `Unsupported audio output extension: ${ext || "(none)"}. Use one of: ${Object.keys(AUDIO_CODECS).join(", ")}`,
    );
  }
  return [
    "-i",
    opts.input,
    "-y",
    "-vn", // drop embedded cover art; the output is audio only
    "-c:a",
    entry.codec,
    ...(entry.lossless ? [] : ["-b:a", opts.bitrate]),
    "-ar",
    String(opts.sampleRate),
    "-ac",
    "1", // mono — Gemini uses mono
    opts.output,
  ];
}

export async function optimizeAudio(opts: OptimizeAudioOptions): Promise<void> {
  const { input, output, bitrate = "64k", sampleRate = 16000, verbose, logger } = opts;

  // Reject an unsupported output before touching ffmpeg.
  const args = buildAudioArgs({ input, output, bitrate, sampleRate });

  await assertFfmpeg();

  const info = await getMediaInfo(input);
  if (!info.duration) throw new ValidationError(`Cannot read media info from: ${input}`);

  if (verbose && logger) {
    logger.info(`Input: ${input}`);
    logger.info(`  Size: ${((info.sizeByes ?? 0) / 1024 / 1024).toFixed(2)} MB`);
    logger.info(`  Duration: ${(info.duration ?? 0).toFixed(2)}s`);
  }

  await runFfmpeg(args, { verbose, logger });
  logger?.success(`Optimized: ${output}`);
}
