/**
 * `media frames`: extract evenly spaced still frames (and optionally one
 * contact sheet) from a local video, with a manifest that pins each frame to
 * the exact source digest and its presentation time. Extraction is local:
 * the manifest says `model_reviewed: false`, because a frame on disk is not
 * a frame anyone (or any model) has looked at.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { ProviderError, ValidationError } from "../../core/errors.js";
import { assertFfmpeg } from "./ffmpeg-runner.js";
import { firstVideo, probeMedia } from "./media-probe.js";
import { ffInput, resolveMediaSource } from "./media-source.js";

export const FRAMES_SCHEMA = "multix.media-frames/v1";
export const MAX_FRAMES = 100;

export interface FrameEntry {
  index: number;
  requested_s: number;
  /** Presentation time of the frame actually written, from ffmpeg's showinfo. */
  pts_time_s: number | null;
  file: string;
  sha256: string;
}

export interface FramesManifest {
  schema: typeof FRAMES_SCHEMA;
  source: { path: string; sha256: string; bytes: number };
  stream: {
    index: number;
    time_base: string | null;
    frame_rate: string | null;
    width: number | null;
    height: number | null;
  };
  duration_s: number;
  frames: FrameEntry[];
  sheet: { file: string; sha256: string; columns: number; rows: number; tile_width: number } | null;
  coverage: { sampled_frames: number; local_extraction: true; model_reviewed: false };
}

export interface FramesOptions {
  outDir: string;
  count: number;
  sheet?: boolean;
  sheetWidth?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Midpoints of `count` equal slices of [0, duration). */
export function sampleTimes(duration: number, count: number): number[] {
  return Array.from(
    { length: count },
    (_, i) => Math.round(((i + 0.5) * duration * 1e6) / count) / 1e6,
  );
}

export async function extractFrames(input: string, opts: FramesOptions): Promise<FramesManifest> {
  if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > MAX_FRAMES)
    throw new ValidationError(`--count must be an integer from 1 to ${MAX_FRAMES}`);
  const outDir = path.resolve(opts.outDir);
  const taken = fs.existsSync(outDir)
    ? fs.readdirSync(outDir).filter((f) => /^(frame-\d{3}\.png|sheet\.png|frames\.json)$/.test(f))
    : [];
  if (taken.length > 0)
    throw new ValidationError(
      `Output directory already holds ${taken[0]}; pick another --output-dir so earlier frames are not overwritten`,
    );
  const src = await resolveMediaSource(input);
  const probe = await probeMedia(src.resolved, opts);
  const video = firstVideo(probe);
  if (!video) throw new ValidationError("No video stream to sample frames from");
  // The picture can end before the container (a longer audio track): sample the video's own span.
  const duration = video.duration_s ?? probe.duration_s;
  if (duration === null || duration <= 0)
    throw new ValidationError("Video duration is unknown; cannot place sample times");
  await assertFfmpeg();

  // Frames go to a hidden staging directory first, so a failed run leaves nothing half-written.
  fs.mkdirSync(outDir, { recursive: true });
  const stage = fs.mkdtempSync(path.join(outDir, ".frames-"));
  try {
    const frames: FrameEntry[] = [];
    for (const [i, t] of sampleTimes(duration, opts.count).entries()) {
      const name = `frame-${String(i + 1).padStart(3, "0")}.png`;
      const res = await execa(
        "ffmpeg",
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "level+info",
          "-ss",
          String(t),
          ...ffInput(src.resolved, { formatName: probe.format_name }),
          "-map",
          `0:${video.index}`,
          "-frames:v",
          "1",
          "-vf",
          "showinfo",
          "-y",
          // Relative to the staging cwd: a `%` in --output-dir is not an image2 pattern.
          name,
        ],
        {
          cwd: stage,
          reject: false,
          stdin: "ignore",
          timeout: opts.timeoutMs,
          cancelSignal: opts.signal,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      if (res.exitCode !== 0 || !fs.existsSync(path.join(stage, name)))
        throw new ProviderError(
          `ffmpeg could not extract a frame at ${t} s: ${String(res.stderr).trim().split("\n").slice(-2).join(" ")}`,
          "ffmpeg",
        );
      const pts = String(res.stderr).match(/pts_time:\s*(-?[\d.]+)/)?.[1];
      // showinfo reports time relative to the seek point.
      frames.push({
        index: i + 1,
        requested_s: t,
        pts_time_s: pts === undefined ? null : Math.round((t + Number(pts)) * 1e6) / 1e6,
        file: name,
        sha256: sha256(path.join(stage, name)),
      });
    }

    let sheet: FramesManifest["sheet"] = null;
    if (opts.sheet) {
      const columns = Math.ceil(Math.sqrt(frames.length));
      const rows = Math.ceil(frames.length / columns);
      const tileWidth = opts.sheetWidth ?? 320;
      const res = await execa(
        "ffmpeg",
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-protocol_whitelist",
          "file",
          "-start_number",
          "1",
          "-i",
          "frame-%03d.png",
          "-vf",
          `scale=${tileWidth}:-2,tile=${columns}x${rows}`,
          "-frames:v",
          "1",
          "-y",
          "sheet.png",
        ],
        {
          cwd: stage,
          reject: false,
          stdin: "ignore",
          timeout: opts.timeoutMs,
          cancelSignal: opts.signal,
        },
      );
      if (res.exitCode !== 0)
        throw new ProviderError(
          `ffmpeg could not build the contact sheet: ${String(res.stderr).trim().slice(-300)}`,
          "ffmpeg",
        );
      sheet = {
        file: "sheet.png",
        sha256: sha256(path.join(stage, "sheet.png")),
        columns,
        rows,
        tile_width: tileWidth,
      };
    }

    const manifest: FramesManifest = {
      schema: FRAMES_SCHEMA,
      source: { path: src.path, sha256: src.sha256, bytes: src.bytes },
      stream: {
        index: video.index,
        time_base: video.time_base,
        frame_rate: video.avg_frame_rate
          ? `${video.avg_frame_rate.num}/${video.avg_frame_rate.den}`
          : null,
        width: video.display_width,
        height: video.display_height,
      },
      duration_s: duration,
      frames,
      sheet,
      coverage: { sampled_frames: frames.length, local_extraction: true, model_reviewed: false },
    };
    fs.writeFileSync(path.join(stage, "frames.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const f of fs.readdirSync(stage)) fs.renameSync(path.join(stage, f), path.join(outDir, f));
    return manifest;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
