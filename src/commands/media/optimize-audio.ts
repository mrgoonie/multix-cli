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

interface AudioCodec {
  codec: string;
  /** Lossless/PCM codecs ignore a target bitrate, so `-b:a` is not passed. */
  lossless?: boolean;
}

/** Audio encoder for each output extension; the container must be able to hold the codec. */
const AUDIO_CODECS: Record<string, AudioCodec> = {
  ".mp3": { codec: "libmp3lame" },
  ".m4a": { codec: "aac" },
  ".aac": { codec: "aac" },
  ".opus": { codec: "libopus" },
  ".ogg": { codec: "libopus" },
  ".wav": { codec: "pcm_s16le", lossless: true },
  ".aiff": { codec: "pcm_s16be", lossless: true },
  ".flac": { codec: "flac", lossless: true },
};

/** Builds the ffmpeg arguments, picking the encoder from the output extension. */
export function buildAudioArgs(opts: {
  input: string;
  output: string;
  bitrate: string;
  sampleRate: number;
}): string[] {
  const ext = path.extname(opts.output).toLowerCase();
  const audio = AUDIO_CODECS[ext];
  if (!audio) {
    throw new ValidationError(
      `Unsupported audio output extension: ${ext || "(none)"}. Use one of: ${Object.keys(AUDIO_CODECS).join(", ")}`,
    );
  }

  // libopus caps a mono stream at 256 kbps and fails inside ffmpeg above that.
  const kbps = /^(\d+)k$/i.exec(opts.bitrate);
  if (audio.codec === "libopus" && kbps && Number(kbps[1]) > 256) {
    throw new ValidationError(
      `Opus output supports at most 256k for mono audio, got ${opts.bitrate}`,
    );
  }

  return [
    "-i",
    opts.input,
    "-y",
    "-c:a",
    audio.codec,
    ...(audio.lossless ? [] : ["-b:a", opts.bitrate]),
    "-ar",
    String(opts.sampleRate),
    "-ac",
    "1", // mono — Gemini uses mono
    opts.output,
  ];
}

export async function optimizeAudio(opts: OptimizeAudioOptions): Promise<void> {
  const { input, output, bitrate = "64k", sampleRate = 16000, verbose, logger } = opts;

  // Reject an unsupported output extension before touching ffmpeg.
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
