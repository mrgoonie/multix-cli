/**
 * `media verify`: judge one local media file against a versioned profile and
 * return a receipt bound to the exact bytes judged (sha256). Every finding
 * carries its unit, time range (and frame range for video) and the threshold
 * that produced it. Anything that was not measured is reported as unknown or
 * not measured, and makes the receipt `incomplete` rather than a false pass.
 * Runs offline; no provider is called.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { ValidationError } from "../../core/errors.js";
import { assertFfmpeg, assertFfprobe } from "./ffmpeg-runner.js";
import {
  type AnalysisPlan,
  type AnalysisResult,
  type TimeRange,
  analyzeMedia,
} from "./media-analyze.js";
import { type InspectReport, inspectSource } from "./media-inspect.js";
import { RULE_INPUT_SCHEMA, type RuleRun, resolveRuleFile, runRule } from "./media-rule.js";
import { hashFile, resolveMediaSource } from "./media-source.js";
import type { Severity, VerifyProfile } from "./verify-profiles.js";

export const VERIFY_SCHEMA = "multix.media-verify/v1";
/** Bumped when measuring or judging logic changes; part of every cache key. */
export const VERIFY_ENGINE = "multix-media-verify/2";

export type CheckStatus = "pass" | "warn" | "fail" | "skipped" | "unknown";

export interface Finding extends TimeRange {
  start_frame?: number;
  end_frame?: number;
  /** Inside a range the caller declared intentional (fade, hold, pause). */
  intentional?: boolean;
  allowed_by?: string;
  message?: string;
}

export interface CheckResult {
  id: string;
  rule_version: string;
  status: CheckStatus;
  severity: Severity | null;
  unit?: string;
  threshold?: Record<string, number | string | boolean>;
  measured?: Record<string, number | string | boolean | null>;
  findings?: Finding[];
  reason?: string;
}

export interface VerifyReceipt {
  schema: typeof VERIFY_SCHEMA;
  status: "pass" | "fail" | "incomplete";
  generated_at: string;
  engine: { id: string; ffmpeg: string | null };
  source: {
    path: string;
    sha256: string;
    bytes: number;
    container: string | null;
    extension_matches: boolean | null;
    kind: InspectReport["kind"];
  };
  profile: {
    id: string;
    version: number;
    origin: "builtin" | "file";
    sha256: string;
    media: VerifyProfile["media"];
  };
  expectations: VerifyExpectations;
  timebase: {
    video_time_base: string | null;
    frame_rate: string | null;
    frame_rate_basis: "avg_frame_rate" | "r_frame_rate" | null;
    variable_frame_rate: boolean | null;
  };
  coverage: {
    media_duration_s: number | null;
    decoded_s: number | null;
    ratio: number | null;
    completed: boolean;
    /** Every frame/sample was decoded locally; no frame was reviewed by a model. */
    model_reviewed: false;
  };
  checks: CheckResult[];
  not_measured: Array<{ id: string; reason: string }>;
  rules: Array<{
    file: string;
    sha256: string;
    id?: string;
    version?: string | number;
    error?: string;
  }>;
  summary: { errors: number; warnings: number; intentional: number; unknown: number };
  cache?: { key: string; hit: boolean };
}

export interface VerifyExpectations {
  duration_s?: number;
  duration_tolerance_s?: number;
  aspect_ratio?: string;
  aspect_tolerance?: number;
  loudness_lufs?: number;
  loudness_tolerance_lu?: number;
  allow_black?: string[];
  allow_freeze?: string[];
  allow_silence?: string[];
}

export interface VerifyOptions {
  profile: VerifyProfile;
  profileOrigin?: "builtin" | "file";
  expect?: VerifyExpectations;
  rules?: string[];
  ruleTimeoutMs?: number;
  timeoutMs?: number;
  cacheDir?: string;
  signal?: AbortSignal;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** JSON with sorted keys, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const sha256Text = (text: string) => createHash("sha256").update(text).digest("hex");

/** "1.5-3" or "1.5:3" as seconds; throws on anything else. */
export function parseRange(text: string): { start: number; end: number } {
  const m = text.trim().match(/^(\d+(?:\.\d+)?)\s*[-:]\s*(\d+(?:\.\d+)?)$/);
  if (!m)
    throw new ValidationError(`Invalid range "${text}": use START-END in seconds, e.g. 0-1.5`);
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (end <= start) throw new ValidationError(`Invalid range "${text}": end must be after start`);
  return { start, end };
}

/** "16:9", "9/16" or "1.7778" as a ratio. */
export function parseAspect(text: string): number {
  const m = text.trim().match(/^(\d+(?:\.\d+)?)(?:\s*[:/x]\s*(\d+(?:\.\d+)?))?$/);
  const ratio = m ? Number(m[1]) / (m[2] ? Number(m[2]) : 1) : Number.NaN;
  if (!Number.isFinite(ratio) || ratio <= 0)
    throw new ValidationError(`Invalid aspect ratio "${text}": use W:H, e.g. 16:9`);
  return ratio;
}

let ffmpegVersionCache: string | null | undefined;
async function ffmpegVersion(): Promise<string | null> {
  if (ffmpegVersionCache !== undefined) return ffmpegVersionCache;
  try {
    const res = await execa("ffmpeg", ["-hide_banner", "-version"], {
      reject: false,
      stdin: "ignore",
    });
    ffmpegVersionCache = String(res.stdout).match(/ffmpeg version (\S+)/)?.[1] ?? null;
  } catch {
    ffmpegVersionCache = null;
  }
  return ffmpegVersionCache;
}

function framesOf(r: TimeRange, fps: number | null): Pick<Finding, "start_frame" | "end_frame"> {
  if (!fps) return {};
  return {
    start_frame: Math.floor(r.start_s * fps + 1e-6),
    end_frame: Math.max(0, Math.ceil(r.end_s * fps - 1e-6) - 1),
  };
}

function rangedCheck(
  id: string,
  ranges: TimeRange[],
  allow: string[] | undefined,
  severity: Severity,
  threshold: CheckResult["threshold"],
  fps: number | null,
): CheckResult {
  const allowed = (allow ?? []).map((text) => ({ text, ...parseRange(text) }));
  const tolerance = fps ? Math.max(0.05, 1 / fps) : 0.05;
  const findings: Finding[] = ranges.map((r) => {
    const by = allowed.find(
      (a) => r.start_s >= a.start - tolerance && r.end_s <= a.end + tolerance,
    );
    return { ...r, ...framesOf(r, fps), ...(by ? { intentional: true, allowed_by: by.text } : {}) };
  });
  const real = findings.filter((f) => !f.intentional);
  const status: CheckStatus = real.length === 0 ? "pass" : severity === "error" ? "fail" : "warn";
  return { id, rule_version: "1", status, severity, unit: "s", threshold, findings };
}

const MEASURED_CHECKS = new Set([
  "black",
  "freeze",
  "silence",
  "clipping",
  "blank_image",
  "loudness",
]);

/** Builds the checks from what was measured. Exported for tests. */
export function judge(
  report: InspectReport,
  analysis: AnalysisResult | null,
  profile: VerifyProfile,
  expect: VerifyExpectations,
): { checks: CheckResult[]; notMeasured: VerifyReceipt["not_measured"] } {
  const checks: CheckResult[] = [];
  const notMeasured: VerifyReceipt["not_measured"] = [];
  const c = profile.checks;
  const video = report.video;
  const audio = report.audio;
  const rate = video?.avg_frame_rate ?? video?.r_frame_rate ?? null;
  const fps = report.kind === "video" && rate ? rate.value : null;

  // The file must be the kind of media the profile judges.
  const kindOk =
    profile.media === "image"
      ? report.kind === "image"
      : profile.media === "video"
        ? report.kind === "video"
        : report.kind === "audio" || (report.kind === "video" && audio !== null);
  checks.push({
    id: "media_kind",
    rule_version: "1",
    status:
      report.kind === null ? (report.interrupted ? "unknown" : "fail") : kindOk ? "pass" : "fail",
    severity: "error",
    measured: { kind: report.kind },
    threshold: { expected: profile.media },
    ...(report.kind === null
      ? { reason: report.errors.join("; ") || "unreadable media" }
      : kindOk
        ? {}
        : {
            reason: `profile ${profile.id} judges ${profile.media}; this file is ${report.kind}${report.kind === "video" && !audio ? " without audio" : ""}`,
          }),
  });
  if (report.kind === null || !kindOk) return { checks, notMeasured };

  // Integrity: the whole file decodes without errors, as far as its decoded streams claim to
  // run. The container's duration can count tracks that were not decoded, and when ffprobe
  // only estimated it from the bitrate (a raw stream with no index or Xing header) no
  // truncation is asserted from it. A WAV is sized by ffprobe from the bytes present, so its
  // truncation is read from the `data` chunk header instead.
  const videoDecoded = video !== null && profile.media !== "audio";
  const audioDecoded = audio !== null && profile.media !== "image";
  const streamEnds = [
    videoDecoded ? video?.duration_s : null,
    audioDecoded ? audio?.duration_s : null,
  ].filter((d): d is number => typeof d === "number");
  const estimated = report.format?.duration_estimated === true;
  const declared = estimated
    ? null
    : streamEnds.length > 0
      ? Math.max(...streamEnds)
      : (report.format?.duration_s ?? null);
  if (!analysis) {
    checks.push({
      id: "decode",
      rule_version: "2",
      status: "unknown",
      severity: "error",
      reason: "not decoded",
    });
  } else {
    const wav = report.wav_data;
    const truncated =
      report.kind !== "image" &&
      analysis.completed &&
      declared !== null &&
      analysis.decoded_s !== null &&
      analysis.decoded_s < declared - Math.max(0.5, fps ? 2 / fps : 0);
    const status: CheckStatus = wav?.truncated
      ? "fail"
      : !analysis.completed
        ? analysis.timed_out || analysis.cancelled
          ? "unknown"
          : "fail"
        : analysis.decode_error_count > 0 || truncated
          ? "fail"
          : "pass";
    checks.push({
      id: "decode",
      rule_version: "2",
      status,
      severity: "error",
      unit: "s",
      measured: {
        decoded_s: analysis.decoded_s,
        declared_duration_s: declared,
        ...(estimated ? { declared_duration_estimated: true } : {}),
        ...(wav
          ? { declared_data_bytes: wav.declared_bytes, present_data_bytes: wav.present_bytes }
          : {}),
        error_count: analysis.decode_error_count,
        completed: analysis.completed,
      },
      ...(analysis.decode_errors.length || truncated || status !== "pass"
        ? {
            reason: wav?.truncated
              ? `WAV data chunk declares ${wav.declared_bytes} bytes but the file holds ${wav.present_bytes} (truncated)`
              : analysis.timed_out
                ? "decode timed out"
                : analysis.cancelled
                  ? "decode cancelled"
                  : truncated
                    ? `decoded ${analysis.decoded_s} s of a declared ${declared} s (truncated)`
                    : [
                        ...analysis.decode_errors.slice(0, 5),
                        ...(analysis.completed ? [] : analysis.log_tail.slice(-2)),
                      ]
                        .join(" | ")
                        .slice(0, 2000),
          }
        : {}),
    });
  }

  // The picture must run as long as the sound: frames missing at the end are neither black
  // nor frozen to the detectors, since nothing is decoded there.
  if (profile.media === "video" && video?.duration_s != null && audio?.duration_s != null) {
    const tol = Math.max(0.5, fps ? 2 / fps : 0);
    const gap = round(audio.duration_s - video.duration_s);
    checks.push({
      id: "track_lengths",
      rule_version: "1",
      status: gap > tol ? "fail" : -gap > tol ? "warn" : "pass",
      severity: gap > tol ? "error" : "warning",
      unit: "s",
      threshold: { tolerance_s: round(tol) },
      measured: { video_s: video.duration_s, audio_s: audio.duration_s },
      ...(gap > tol
        ? { reason: `the picture ends ${gap} s before the audio` }
        : -gap > tol
          ? { reason: `the audio ends ${-gap} s before the picture` }
          : {}),
    });
  }

  if (expect.duration_s !== undefined) {
    const measured = analysis?.completed ? analysis.decoded_s : null;
    const tol = expect.duration_tolerance_s ?? Math.max(0.1, fps ? 1 / fps : 0);
    checks.push({
      id: "duration",
      rule_version: "1",
      status:
        measured === null
          ? "unknown"
          : Math.abs(measured - expect.duration_s) <= tol
            ? "pass"
            : "fail",
      severity: "error",
      unit: "s",
      threshold: { expected_s: expect.duration_s, tolerance_s: round(tol) },
      measured: {
        decoded_s: measured,
        delta_s: measured === null ? null : round(measured - expect.duration_s),
      },
      ...(measured === null ? { reason: "the decoded duration was not measured to the end" } : {}),
    });
  }

  if (expect.aspect_ratio !== undefined) {
    const want = parseAspect(expect.aspect_ratio);
    const tol = expect.aspect_tolerance ?? 0.01;
    const w = video?.display_width ?? null;
    const h = video?.display_height ?? null;
    const got = w && h ? w / h : null;
    checks.push({
      id: "aspect_ratio",
      rule_version: "1",
      status: got === null ? "unknown" : Math.abs(got - want) / want <= tol ? "pass" : "fail",
      severity: "error",
      unit: "ratio",
      threshold: { expected: expect.aspect_ratio, relative_tolerance: tol },
      measured: {
        display_width: w,
        display_height: h,
        ratio: got === null ? null : round(got),
        rotation_deg: video?.rotation_deg ?? 0,
      },
    });
  }

  if (c.audio_required) {
    checks.push({
      id: "audio_present",
      rule_version: "1",
      status: audio ? "pass" : c.audio_required === "error" ? "fail" : "warn",
      severity: c.audio_required,
      measured: { audio_streams: report.streams.filter((s) => s.type === "audio").length },
    });
  }

  const skip = (id: string, reason: string, severity: Severity) =>
    checks.push({ id, rule_version: "1", status: "skipped", severity, reason });
  const usable = analysis !== null;

  if (c.black) {
    const t = {
      min_duration_s: c.black.min_duration_s,
      pixel_threshold: c.black.pixel_threshold,
      picture_threshold: c.black.picture_threshold,
    };
    if (report.kind !== "video") skip("black", "not a video", c.black.severity);
    else if (usable)
      checks.push(
        rangedCheck("black", analysis.black, expect.allow_black, c.black.severity, t, fps),
      );
  }
  if (c.freeze) {
    const t = { noise_db: c.freeze.noise_db, min_duration_s: c.freeze.min_duration_s };
    if (report.kind !== "video") skip("freeze", "not a video", c.freeze.severity);
    else if (usable)
      checks.push(
        // A declared black hold is also a still picture: it covers the freeze it causes.
        rangedCheck(
          "freeze",
          analysis.freeze,
          [...(expect.allow_freeze ?? []), ...(expect.allow_black ?? [])],
          c.freeze.severity,
          t,
          fps,
        ),
      );
  }
  if (c.blank_image && usable) {
    const max = analysis.black_frames.reduce((m, f) => Math.max(m, f.pblack), -1);
    const t = {
      pixel_threshold: c.blank_image.pixel_threshold,
      max_black_percent: c.blank_image.max_black_percent,
    };
    checks.push({
      id: "blank_image",
      rule_version: "1",
      status:
        max < 0
          ? "unknown"
          : max >= c.blank_image.max_black_percent
            ? c.blank_image.severity === "error"
              ? "fail"
              : "warn"
            : "pass",
      severity: c.blank_image.severity,
      unit: "%",
      threshold: t,
      measured: { black_percent: max < 0 ? null : max },
    });
  }
  if (c.silence) {
    const t = { noise_db: c.silence.noise_db, min_duration_s: c.silence.min_duration_s };
    if (!audio) skip("silence", "no audio stream", c.silence.severity);
    else if (usable)
      checks.push(
        rangedCheck("silence", analysis.silence, expect.allow_silence, c.silence.severity, t, null),
      );
  }
  // ebur128 reports true peak to 0.1 dB, so a hard-clipped signal reads exactly 0.0: reaching
  // the ceiling fails, not only exceeding it.
  if (c.clipping) {
    const peak = analysis?.loudness?.true_peak_dbtp;
    if (!audio) skip("clipping", "no audio stream", c.clipping.severity);
    else if (usable)
      checks.push({
        id: "clipping",
        rule_version: "1",
        status:
          peak === undefined
            ? "unknown"
            : peak === null || peak < c.clipping.max_true_peak_dbtp
              ? "pass"
              : c.clipping.severity === "error"
                ? "fail"
                : "warn",
        severity: c.clipping.severity,
        unit: "dBTP",
        threshold: { max_true_peak_dbtp: c.clipping.max_true_peak_dbtp },
        measured: { true_peak_dbtp: peak ?? null },
      });
  }
  if (expect.loudness_lufs !== undefined) {
    const lufs = analysis?.loudness?.integrated_lufs;
    const tol = expect.loudness_tolerance_lu ?? 1;
    checks.push({
      id: "loudness",
      rule_version: "1",
      status: !audio
        ? "fail"
        : lufs === undefined || lufs === null
          ? "unknown"
          : Math.abs(lufs - expect.loudness_lufs) <= tol
            ? "pass"
            : "fail",
      severity: "error",
      unit: "LUFS",
      threshold: { target_lufs: expect.loudness_lufs, tolerance_lu: tol },
      measured: {
        integrated_lufs: lufs ?? null,
        loudness_range_lu: analysis?.loudness?.loudness_range_lu ?? null,
      },
      ...(!audio ? { reason: "no audio stream" } : {}),
    });
  }

  // A decode that stopped early (timeout, cancel, fatal error) only proves what it found:
  // a measuring check without findings is unknown, not a pass.
  if (analysis && !analysis.completed) {
    for (const check of checks) {
      if (check.status === "pass" && MEASURED_CHECKS.has(check.id)) {
        check.status = "unknown";
        check.reason = `decoding stopped ${analysis.decoded_s === null ? "before any progress was reported" : `at ${analysis.decoded_s} s`}; the rest was not measured`;
      }
    }
  }

  if (report.kind === "video" && audio)
    notMeasured.push({
      id: "av_sync",
      reason:
        "audio/video offset and lip sync are not measured; equal stream durations do not prove sync",
    });
  if (report.kind !== "image")
    notMeasured.push({
      id: "content",
      reason: "content correctness and aesthetics are not judged by measurements",
    });
  return { checks, notMeasured };
}

function planFor(
  report: InspectReport,
  profile: VerifyProfile,
  expect: VerifyExpectations,
): AnalysisPlan {
  const c = profile.checks;
  const plan: AnalysisPlan = { formatName: report.format?.format_name };
  if (
    report.video &&
    (report.kind === "video" || report.kind === "image") &&
    profile.media !== "audio"
  ) {
    plan.video = { streamIndex: report.video.index };
    if (report.kind === "video" && c.black)
      plan.video.black = {
        minDurationS: c.black.min_duration_s,
        pixelThreshold: c.black.pixel_threshold,
        pictureThreshold: c.black.picture_threshold,
      };
    if (report.kind === "video" && c.freeze)
      plan.video.freeze = { noiseDb: c.freeze.noise_db, minDurationS: c.freeze.min_duration_s };
    if (report.kind === "image" && c.blank_image)
      plan.video.blackframe = { pixelThreshold: c.blank_image.pixel_threshold };
  }
  if (report.audio && profile.media !== "image") {
    plan.audio = { streamIndex: report.audio.index };
    if (c.silence)
      plan.audio.silence = { noiseDb: c.silence.noise_db, minDurationS: c.silence.min_duration_s };
    if (c.clipping || expect.loudness_lufs !== undefined) plan.audio.loudness = true;
  }
  return plan;
}

function summarise(checks: CheckResult[]): VerifyReceipt["summary"] {
  const s = { errors: 0, warnings: 0, intentional: 0, unknown: 0 };
  for (const c of checks) {
    if (c.status === "fail") s.errors++;
    if (c.status === "warn") s.warnings++;
    if (c.status === "unknown") s.unknown++;
    s.intentional += (c.findings ?? []).filter((f) => f.intentional).length;
  }
  return s;
}

export async function verifyMedia(input: string, opts: VerifyOptions): Promise<VerifyReceipt> {
  const expect = opts.expect ?? {};
  // Validate declared ranges and ratios before any decoding.
  for (const r of [
    ...(expect.allow_black ?? []),
    ...(expect.allow_freeze ?? []),
    ...(expect.allow_silence ?? []),
  ])
    parseRange(r);
  if (expect.aspect_ratio !== undefined) parseAspect(expect.aspect_ratio);
  const rules = (opts.rules ?? []).map(resolveRuleFile);
  // Without ffmpeg nothing can be measured: stop with an install hint, never a verdict.
  await assertFfprobe();
  await assertFfmpeg();

  const src = await resolveMediaSource(input, opts.signal);
  const profileJson = canonicalJson(opts.profile);
  const ruleFiles = await Promise.all(
    rules.map(async (file) => ({ file, sha256: (await hashFile(file, opts.signal)).sha256 })),
  );
  const ffmpeg = await ffmpegVersion();
  const key = sha256Text(
    canonicalJson({
      engine: VERIFY_ENGINE,
      ffmpeg,
      source: src.sha256,
      profile: profileJson,
      expect,
      rules: ruleFiles.map((r) => r.sha256),
    }),
  );

  const cacheFile = opts.cacheDir ? path.join(opts.cacheDir, `${key}.json`) : undefined;
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as VerifyReceipt;
      if (
        cached.schema === VERIFY_SCHEMA &&
        cached.source?.sha256 === src.sha256 &&
        cached.status !== "incomplete"
      )
        return {
          ...cached,
          source: { ...cached.source, path: src.path },
          cache: { key, hit: true },
        };
    } catch {
      // A corrupt cache entry is ignored and rewritten.
    }
  }

  const report = await inspectSource(src, { timeoutMs: opts.timeoutMs, signal: opts.signal });
  const kindOk = report.kind !== null;
  const analysis = kindOk
    ? await analyzeMedia(src.resolved, {
        ...planFor(report, opts.profile, expect),
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      })
    : null;
  const { checks, notMeasured } = judge(report, analysis, opts.profile, expect);

  const ruleRecords: VerifyReceipt["rules"] = [];
  for (const rf of ruleFiles) {
    const run: RuleRun = await runRule(
      rf.file,
      rf.sha256,
      {
        schema: RULE_INPUT_SCHEMA,
        source: { path: src.resolved, sha256: src.sha256, bytes: src.bytes },
        profile: opts.profile,
        inspect: report,
        analysis,
      },
      { timeoutMs: opts.ruleTimeoutMs ?? 30_000, signal: opts.signal },
    );
    ruleRecords.push({
      file: rf.file,
      sha256: rf.sha256,
      id: run.verdict?.id,
      version: run.verdict?.version,
      error: run.error,
    });
    const v = run.verdict;
    checks.push(
      v
        ? {
            id: `rule:${v.id}`,
            rule_version: String(v.version),
            status: v.status,
            severity: v.status === "warn" ? "warning" : "error",
            ...(v.message ? { reason: v.message } : {}),
            findings: (v.findings ?? []).map((f) => ({
              start_s: f.start_s ?? 0,
              end_s: f.end_s ?? f.start_s ?? 0,
              duration_s: round((f.end_s ?? f.start_s ?? 0) - (f.start_s ?? 0)),
              message: f.message,
            })),
          }
        : {
            id: `rule:${path.basename(rf.file)}`,
            rule_version: rf.sha256.slice(0, 12),
            status: "unknown",
            severity: "error",
            reason: run.error,
          },
    );
  }

  // The bytes judged must be the bytes named in the receipt. A cancelled run is incomplete
  // anyway, so it does not wait to re-read the file.
  const cancelled = opts.signal?.aborted === true;
  const changed = !cancelled && (await hashFile(src.resolved, opts.signal)).sha256 !== src.sha256;
  const summary = summarise(checks);
  const incomplete =
    cancelled ||
    changed ||
    (analysis !== null && !analysis.completed && (analysis.timed_out || analysis.cancelled)) ||
    summary.unknown > 0;
  const declared = report.format?.duration_s ?? null;
  const rate = report.video?.avg_frame_rate
    ? "avg_frame_rate"
    : report.video?.r_frame_rate
      ? "r_frame_rate"
      : null;
  const receipt: VerifyReceipt = {
    schema: VERIFY_SCHEMA,
    status: summary.errors > 0 && !changed ? "fail" : incomplete ? "incomplete" : "pass",
    generated_at: new Date().toISOString(),
    engine: { id: VERIFY_ENGINE, ffmpeg },
    source: {
      path: src.path,
      sha256: src.sha256,
      bytes: src.bytes,
      container: report.sniff.container,
      extension_matches: report.sniff.extension_matches,
      kind: report.kind,
    },
    profile: {
      id: opts.profile.id,
      version: opts.profile.version,
      origin: opts.profileOrigin ?? "builtin",
      sha256: sha256Text(profileJson),
      media: opts.profile.media,
    },
    expectations: expect,
    timebase: {
      video_time_base: report.video?.time_base ?? null,
      frame_rate:
        rate && report.video?.[rate]
          ? `${report.video[rate]?.num}/${report.video[rate]?.den}`
          : null,
      frame_rate_basis: rate,
      variable_frame_rate: report.video?.variable_frame_rate ?? null,
    },
    coverage: {
      media_duration_s: declared,
      decoded_s: analysis?.decoded_s ?? null,
      ratio:
        declared && analysis?.decoded_s != null
          ? round(Math.min(1, analysis.decoded_s / declared))
          : null,
      completed: analysis?.completed ?? false,
      model_reviewed: false,
    },
    checks,
    not_measured: changed
      ? [
          ...notMeasured,
          {
            id: "source_stable",
            reason: "the file changed while it was being verified; verify it again",
          },
        ]
      : notMeasured,
    rules: ruleRecords,
    summary,
    ...(cacheFile ? { cache: { key, hit: false } } : {}),
  };
  if (cacheFile && receipt.status !== "incomplete") {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(receipt));
    fs.renameSync(tmp, cacheFile);
  }
  return receipt;
}
