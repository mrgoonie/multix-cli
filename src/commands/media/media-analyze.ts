/**
 * One full decode of a media file through ffmpeg's measuring filters
 * (blackdetect, freezedetect, blackframe, silencedetect, ebur128). The log is
 * read line by line, so memory stays bounded whatever the file's length, and
 * a timeout or cancellation still returns what was measured up to that point
 * with `completed: false`.
 */

import readline from "node:readline";
import type { Readable } from "node:stream";
import { execa } from "execa";
import { assertFfmpeg } from "./ffmpeg-runner.js";
import { ffInput } from "./media-source.js";

export interface TimeRange {
  start_s: number;
  end_s: number;
  duration_s: number;
  /** The range was still open when decoding stopped; its end is where decoding stopped. */
  open_end?: boolean;
}

export interface AnalysisPlan {
  video?: {
    streamIndex: number;
    black?: { minDurationS: number; pixelThreshold: number; pictureThreshold: number };
    freeze?: { noiseDb: number; minDurationS: number };
    /** Per-frame share of black pixels (for still images). */
    blackframe?: { pixelThreshold: number };
  };
  audio?: {
    streamIndex: number;
    silence?: { noiseDb: number; minDurationS: number };
    loudness?: boolean;
  };
  /** ffprobe's format_name for the file, so a `%` in an image path is read literally. */
  formatName?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface Loudness {
  integrated_lufs: number | null;
  loudness_range_lu: number | null;
  true_peak_dbtp: number | null;
}

export interface AnalysisResult {
  /** Media time decoded, from ffmpeg's progress report; null when it reported none. */
  decoded_s: number | null;
  /** ffmpeg reached the end of the input. */
  completed: boolean;
  timed_out: boolean;
  cancelled: boolean;
  exit_code: number | null;
  decode_error_count: number;
  /** First decode error lines (capped). */
  decode_errors: string[];
  black: TimeRange[];
  freeze: TimeRange[];
  silence: TimeRange[];
  black_frames: Array<{ frame: number; pblack: number }>;
  loudness: Loudness | null;
  /** Last log lines, for a failure message. */
  log_tail: string[];
}

const MAX_ERRORS_KEPT = 20;
const LOG_TAIL = 15;
const MAX_LINE = 2000;

const round = (n: number) => Math.round(n * 1e6) / 1e6;

function range(start: number, end: number, openEnd = false): TimeRange {
  const s = Math.max(0, start);
  const e = Math.max(s, end);
  return {
    start_s: round(s),
    end_s: round(e),
    duration_s: round(e - s),
    ...(openEnd ? { open_end: true } : {}),
  };
}

/** The ffmpeg argument list for a plan (exported for tests). */
export function analysisArgs(resolved: string, plan: AnalysisPlan): string[] {
  const args = [
    "-nostdin",
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "level+info",
    ...ffInput(resolved, { formatName: plan.formatName }),
  ];
  if (plan.video) {
    const v = plan.video;
    const filters: string[] = [];
    if (v.black)
      filters.push(
        `blackdetect=d=${v.black.minDurationS}:pix_th=${v.black.pixelThreshold}:pic_th=${v.black.pictureThreshold}`,
      );
    if (v.freeze) filters.push(`freezedetect=n=${v.freeze.noiseDb}dB:d=${v.freeze.minDurationS}`);
    if (v.blackframe) filters.push(`blackframe=amount=0:threshold=${v.blackframe.pixelThreshold}`);
    args.push("-map", `0:${v.streamIndex}`);
    if (filters.length) args.push("-vf", filters.join(","));
  }
  if (plan.audio) {
    const a = plan.audio;
    const filters: string[] = [];
    if (a.silence)
      filters.push(`silencedetect=n=${a.silence.noiseDb}dB:d=${a.silence.minDurationS}`);
    if (a.loudness) filters.push("ebur128=peak=true:framelog=quiet");
    args.push("-map", `0:${a.streamIndex}`);
    if (filters.length) args.push("-af", filters.join(","));
  }
  args.push("-progress", "pipe:1", "-f", "null", "-");
  return args;
}

/** Incremental parser for ffmpeg's `level+info` log; exported for tests. */
export class AnalysisLogParser {
  readonly result: Omit<
    AnalysisResult,
    "decoded_s" | "completed" | "timed_out" | "cancelled" | "exit_code"
  > = {
    decode_error_count: 0,
    decode_errors: [],
    black: [],
    freeze: [],
    silence: [],
    black_frames: [],
    loudness: null,
    log_tail: [],
  };
  private freezeStart: number | null = null;
  private silenceStart: number | null = null;
  private inSummary = false;

  line(raw: string): void {
    const line = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw;
    const r = this.result;
    r.log_tail.push(line);
    if (r.log_tail.length > LOG_TAIL) r.log_tail.shift();

    if (/\[(error|fatal|panic)\]/.test(line)) {
      r.decode_error_count++;
      if (r.decode_errors.length < MAX_ERRORS_KEPT)
        r.decode_errors.push(line.replace(/ @ 0x[0-9a-f]+/, ""));
      return;
    }
    let m = line.match(/black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)/);
    if (m) {
      r.black.push(range(Number(m[1]), Number(m[2])));
      return;
    }
    m = line.match(/freezedetect\.freeze_start:\s*(-?[\d.]+)/);
    if (m) {
      this.freezeStart = Number(m[1]);
      return;
    }
    m = line.match(/freezedetect\.freeze_end:\s*(-?[\d.]+)/);
    if (m) {
      if (this.freezeStart !== null) r.freeze.push(range(this.freezeStart, Number(m[1])));
      this.freezeStart = null;
      return;
    }
    m = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (m) {
      this.silenceStart = Number(m[1]);
      return;
    }
    m = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (m) {
      if (this.silenceStart !== null) r.silence.push(range(this.silenceStart, Number(m[1])));
      this.silenceStart = null;
      return;
    }
    m = line.match(/\bframe:(\d+)\s+pblack:(\d+)/);
    if (m) {
      if (r.black_frames.length < 10_000)
        r.black_frames.push({ frame: Number(m[1]), pblack: Number(m[2]) });
      return;
    }
    if (/Parsed_ebur128.*Summary:/.test(line)) {
      this.inSummary = true;
      r.loudness = { integrated_lufs: null, loudness_range_lu: null, true_peak_dbtp: null };
      return;
    }
    if (this.inSummary && r.loudness) {
      const value = (re: RegExp) => {
        const v = line.match(re)?.[1];
        return v === undefined ? undefined : /inf/i.test(v) ? null : Number(v);
      };
      const i = value(/^\s*I:\s+(-?inf|-?[\d.]+)\s+LUFS/);
      if (i !== undefined) r.loudness.integrated_lufs = i;
      const lra = value(/^\s*LRA:\s+(-?inf|-?[\d.]+)\s+LU\b/);
      if (lra !== undefined) r.loudness.loudness_range_lu = lra;
      const peak = value(/^\s*Peak:\s+(-?inf|-?[\d.]+)\s+dBFS/);
      if (peak !== undefined) {
        r.loudness.true_peak_dbtp = peak;
        this.inSummary = false;
      }
    }
  }

  /** Closes ranges still open when decoding stopped at `endS`. */
  finish(endS: number | null): void {
    if (endS === null) return;
    if (this.freezeStart !== null) this.result.freeze.push(range(this.freezeStart, endS, true));
    if (this.silenceStart !== null) this.result.silence.push(range(this.silenceStart, endS, true));
    this.freezeStart = null;
    this.silenceStart = null;
  }
}

function eachLine(stream: Readable | null | undefined, fn: (line: string) => void): Promise<void> {
  if (!stream) return Promise.resolve();
  const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  rl.on("line", fn);
  return new Promise((resolve) => rl.once("close", resolve));
}

export async function analyzeMedia(resolved: string, plan: AnalysisPlan): Promise<AnalysisResult> {
  await assertFfmpeg();
  const parser = new AnalysisLogParser();
  let decodedUs: number | null = null;
  let reachedEnd = false;
  const sub = execa("ffmpeg", analysisArgs(resolved, plan), {
    reject: false,
    buffer: false,
    stdin: "ignore",
    timeout: plan.timeoutMs,
    cancelSignal: plan.signal,
  });
  const done = Promise.all([
    eachLine(sub.stderr, (l) => parser.line(l)),
    eachLine(sub.stdout, (l) => {
      const m = l.match(/^out_time_us=(\d+)/);
      if (m) decodedUs = Number(m[1]);
      if (l === "progress=end") reachedEnd = true;
    }),
  ]);
  const res = await sub;
  await done;
  const decoded_s = decodedUs === null ? null : round(decodedUs / 1e6);
  parser.finish(decoded_s);
  return {
    ...parser.result,
    decoded_s,
    completed: reachedEnd && res.exitCode === 0 && !res.timedOut && !res.isCanceled,
    timed_out: Boolean(res.timedOut),
    cancelled: Boolean(res.isCanceled),
    exit_code: res.exitCode ?? null,
  };
}
