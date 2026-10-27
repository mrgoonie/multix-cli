/**
 * ffprobe metadata normalised for `media inspect`. A value ffprobe does not
 * report, or reports as N/A, stays null: it is unknown, never a valid 0.
 */

import { execa } from "execa";
import { ProviderError } from "../../core/errors.js";
import { assertFfprobe } from "./ffmpeg-runner.js";
import { ffInput } from "./media-source.js";

export interface Rational {
  num: number;
  den: number;
  /** num/den, rounded to 6 decimals. */
  value: number;
}

export interface VideoStreamInfo {
  index: number;
  type: "video";
  codec: string | null;
  profile: string | null;
  pix_fmt: string | null;
  width: number | null;
  height: number | null;
  /** Display rotation, degrees counter-clockwise (0, 90, 180 or 270 in practice). */
  rotation_deg: number;
  /** Size as displayed, after rotation and sample aspect ratio. */
  display_width: number | null;
  display_height: number | null;
  sample_aspect_ratio: string | null;
  r_frame_rate: Rational | null;
  avg_frame_rate: Rational | null;
  /** True when the average rate differs from the base rate (variable frame rate); null when unknown. */
  variable_frame_rate: boolean | null;
  time_base: string | null;
  start_time_s: number | null;
  duration_s: number | null;
  nb_frames: number | null;
  /** Cover art in an audio file, not a video track. */
  attached_pic: boolean;
}

export interface AudioStreamInfo {
  index: number;
  type: "audio";
  codec: string | null;
  sample_rate_hz: number | null;
  channels: number | null;
  channel_layout: string | null;
  time_base: string | null;
  start_time_s: number | null;
  duration_s: number | null;
}

export interface OtherStreamInfo {
  index: number;
  type: string;
  codec: string | null;
}

export type StreamInfo = VideoStreamInfo | AudioStreamInfo | OtherStreamInfo;

export interface ProbeInfo {
  format_name: string | null;
  format_long_name: string | null;
  duration_s: number | null;
  start_time_s: number | null;
  bit_rate: number | null;
  probe_score: number | null;
  streams: StreamInfo[];
}

export interface ProbeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const PROBE_MAX_BUFFER = 8 * 1024 * 1024;

/** A finite number from an ffprobe field, or null for missing, "N/A" and non-numbers. */
export function num(value: unknown): number | null {
  if (value === undefined || value === null || value === "" || value === "N/A") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** "30000/1001" as a rational; null for "0/0", missing or malformed values. */
export function rational(value: unknown): Rational | null {
  if (typeof value !== "string") return null;
  const m = value.match(/^(\d+)\/(\d+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const d = Number(m[2]);
  if (!n || !d) return null;
  return { num: n, den: d, value: Math.round((n / d) * 1e6) / 1e6 };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value !== "unknown" ? value : null;
}

/**
 * Display rotation in degrees counter-clockwise, as ffprobe reports the
 * display matrix; the legacy `rotate` tag counts clockwise.
 */
// biome-ignore lint/suspicious/noExplicitAny: ffprobe JSON
function rotationOf(stream: any): number {
  let ccw: number | null = null;
  for (const side of stream.side_data_list ?? []) {
    ccw = num(side?.rotation);
    if (ccw !== null) break;
  }
  if (ccw === null) {
    const tag = num(stream.tags?.rotate);
    ccw = tag === null ? 0 : -tag;
  }
  return ((Math.round(ccw) % 360) + 360) % 360;
}

// biome-ignore lint/suspicious/noExplicitAny: ffprobe JSON
export function normaliseStream(s: any): StreamInfo {
  const index = num(s.index) ?? -1;
  const codec = str(s.codec_name);
  if (s.codec_type === "video") {
    const width = num(s.width) || null;
    const height = num(s.height) || null;
    const rotation = rotationOf(s);
    const sar = str(s.sample_aspect_ratio);
    const sarR = sar ? rational(sar.replace(":", "/")) : null;
    let dw = width;
    let dh = height;
    if (dw !== null && sarR && sarR.num !== sarR.den) dw = Math.round((dw * sarR.num) / sarR.den);
    if (rotation === 90 || rotation === 270) [dw, dh] = [dh, dw];
    const r = rational(s.r_frame_rate);
    const avg = rational(s.avg_frame_rate);
    return {
      index,
      type: "video",
      codec,
      profile: str(s.profile),
      pix_fmt: str(s.pix_fmt),
      width,
      height,
      rotation_deg: rotation,
      display_width: dw,
      display_height: dh,
      sample_aspect_ratio: sar,
      r_frame_rate: r,
      avg_frame_rate: avg,
      variable_frame_rate: r && avg ? Math.abs(r.value - avg.value) > 0.01 : null,
      time_base: str(s.time_base),
      start_time_s: num(s.start_time),
      duration_s: num(s.duration),
      nb_frames: num(s.nb_frames),
      attached_pic: s.disposition?.attached_pic === 1,
    };
  }
  if (s.codec_type === "audio") {
    return {
      index,
      type: "audio",
      codec,
      sample_rate_hz: num(s.sample_rate) || null,
      channels: num(s.channels) || null,
      channel_layout: str(s.channel_layout),
      time_base: str(s.time_base),
      start_time_s: num(s.start_time),
      duration_s: num(s.duration),
    };
  }
  return { index, type: str(s.codec_type) ?? "unknown", codec };
}

/** Parses ffprobe's `-show_format -show_streams` JSON. */
export function parseProbe(stdout: string): ProbeInfo {
  // biome-ignore lint/suspicious/noExplicitAny: ffprobe JSON
  const data = JSON.parse(stdout) as any;
  const fmt = data.format ?? {};
  return {
    format_name: str(fmt.format_name),
    format_long_name: str(fmt.format_long_name),
    duration_s: num(fmt.duration),
    start_time_s: num(fmt.start_time),
    bit_rate: num(fmt.bit_rate),
    probe_score: num(fmt.probe_score),
    streams: (data.streams ?? []).map(normaliseStream),
  };
}

/** ffprobe was stopped by its timeout or a cancel, so the file's readability is unknown. */
export class ProbeInterruptedError extends ProviderError {}

/** Runs ffprobe on a resolved local path. Throws ProviderError when it cannot read the file. */
export async function probeMedia(resolved: string, opts: ProbeOptions = {}): Promise<ProbeInfo> {
  await assertFfprobe();
  const result = await execa(
    "ffprobe",
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      ...ffInput(resolved, { probe: true }),
    ],
    {
      reject: false,
      timeout: opts.timeoutMs,
      cancelSignal: opts.signal,
      maxBuffer: PROBE_MAX_BUFFER,
      stdin: "ignore",
    },
  );
  if (result.timedOut)
    throw new ProbeInterruptedError(`ffprobe timed out after ${opts.timeoutMs} ms`, "ffprobe");
  if (result.isCanceled) throw new ProbeInterruptedError("ffprobe was cancelled", "ffprobe");
  if (result.exitCode !== 0) {
    const reason =
      String(result.stderr ?? "")
        .trim()
        .split("\n")
        .slice(-3)
        .join(" ") || "unreadable media";
    throw new ProviderError(`ffprobe could not read the file: ${reason}`, "ffprobe");
  }
  return parseProbe(String(result.stdout));
}

export function firstVideo(info: ProbeInfo): VideoStreamInfo | undefined {
  return info.streams.find(
    (s): s is VideoStreamInfo => s.type === "video" && !(s as VideoStreamInfo).attached_pic,
  );
}

export function firstAudio(info: ProbeInfo): AudioStreamInfo | undefined {
  return info.streams.find((s): s is AudioStreamInfo => s.type === "audio");
}
