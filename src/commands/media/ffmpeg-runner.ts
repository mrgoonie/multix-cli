/**
 * Thin execa wrapper around ffmpeg/ffprobe.
 * Uses array-form args to avoid shell injection.
 * Throws ProviderError on non-zero exit; logs stderr at verbose level.
 */

import { execa, ExecaError } from "execa";
import { ProviderError, ValidationError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";

/** Check ffmpeg is on PATH. Throws ValidationError with install hint if not. */
export async function assertFfmpeg(): Promise<void> {
  try {
    await execa("ffmpeg", ["-version"], { reject: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ValidationError(
        "ffmpeg not found on PATH.\n" +
        "  Linux: sudo apt-get install ffmpeg\n" +
        "  macOS: brew install ffmpeg\n" +
        "  Windows: https://ffmpeg.org/download.html",
      );
    }
    // ffmpeg -version exits non-zero on some builds but binary exists — ignore
  }
}

/** Check ffprobe is on PATH (bundled with ffmpeg). */
export async function assertFfprobe(): Promise<void> {
  try {
    await execa("ffprobe", ["-version"], { reject: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ValidationError("ffprobe not found on PATH — install ffmpeg which bundles ffprobe");
    }
  }
}

export interface RunFfmpegOptions {
  verbose?: boolean;
  logger?: Logger;
}

/** Run ffmpeg with the given argument array. Throws ProviderError on non-zero exit. */
export async function runFfmpeg(args: string[], opts: RunFfmpegOptions = {}): Promise<void> {
  const { verbose, logger } = opts;
  logger?.debug(`ffmpeg ${args.join(" ")}`);

  try {
    const result = await execa("ffmpeg", args, { reject: true, all: true });
    if (verbose && result.stderr) logger?.debug(result.stderr);
  } catch (e) {
    const err = e as ExecaError;
    const stderr = (err.stderr ?? err.all ?? "").toString().slice(0, 1000);
    throw new ProviderError(`ffmpeg failed: ${stderr}`, "ffmpeg");
  }
}

export interface MediaInfo {
  sizeByes: number;
  duration: number;
  bitRate: number;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
}

/** Get media file info via ffprobe. Returns partial info on error. */
export async function getMediaInfo(filePath: string): Promise<Partial<MediaInfo>> {
  try {
    const result = await execa("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ], { reject: true });

    // biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
    const data = JSON.parse(result.stdout) as any;
    const fmt = data.format ?? {};

    const info: Partial<MediaInfo> = {
      sizeByes: Number.parseInt(fmt.size ?? "0", 10),
      duration: Number.parseFloat(fmt.duration ?? "0"),
      bitRate: Number.parseInt(fmt.bit_rate ?? "0", 10),
    };

    // biome-ignore lint/suspicious/noExplicitAny: dynamic
    for (const stream of (data.streams ?? []) as any[]) {
      if (stream.codec_type === "video") {
        info.width = stream.width;
        info.height = stream.height;
        // fps as rational string "30000/1001"
        if (stream.r_frame_rate) {
          const [num, den] = (stream.r_frame_rate as string).split("/").map(Number);
          info.fps = den ? (num ?? 0) / (den ?? 1) : num;
        }
      } else if (stream.codec_type === "audio") {
        info.sampleRate = Number.parseInt(stream.sample_rate ?? "0", 10);
        info.channels = stream.channels;
      }
    }

    return info;
  } catch {
    return {};
  }
}
