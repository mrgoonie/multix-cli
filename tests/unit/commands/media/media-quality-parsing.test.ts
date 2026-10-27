import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnalysisLogParser, analysisArgs } from "../../../../src/commands/media/media-analyze.js";
import type { InspectReport } from "../../../../src/commands/media/media-inspect.js";
import {
  normaliseStream,
  num,
  parseProbe,
  rational,
} from "../../../../src/commands/media/media-probe.js";
import {
  extensionMatches,
  sniffContainer,
  wavDataSize,
} from "../../../../src/commands/media/media-sniff.js";
import { assertLocalPath, ffInput } from "../../../../src/commands/media/media-source.js";
import {
  canonicalJson,
  judge,
  parseAspect,
  parseRange,
} from "../../../../src/commands/media/media-verify.js";
import {
  BUILTIN_PROFILES,
  builtinProfile,
  loadProfileFile,
} from "../../../../src/commands/media/verify-profiles.js";
import { ValidationError } from "../../../../src/core/errors.js";

const bytes = (...parts: Array<string | number[]>) =>
  Buffer.concat(
    parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))),
  );

describe("sniffContainer", () => {
  it("names containers from magic bytes, not the extension", () => {
    expect(sniffContainer(bytes([0, 0, 0, 0x20], "ftypisom")).container).toBe("mp4");
    expect(sniffContainer(bytes([0, 0, 0, 0x14], "ftypqt  ")).container).toBe("mov");
    expect(sniffContainer(bytes([0, 0, 0, 0x20], "ftypM4A ")).container).toBe("m4a");
    expect(sniffContainer(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f], "B\x82\x84webm")).container).toBe(
      "webm",
    );
    expect(
      sniffContainer(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f], "B\x82\x88matroska")).container,
    ).toBe("matroska");
    expect(sniffContainer(bytes("RIFF", [0, 0, 0, 0], "AVI LIST")).container).toBe("avi");
    expect(sniffContainer(bytes("RIFF", [0, 0, 0, 0], "WAVEfmt ")).container).toBe("wav");
    expect(sniffContainer(bytes("GIF89a", [1, 0, 1, 0])).container).toBe("gif");
    expect(sniffContainer(bytes([0xff, 0xd8, 0xff, 0xe0])).container).toBe("jpeg");
  });

  it("flags text (error pages, playlists, concat lists) so it never reaches ffprobe", () => {
    expect(sniffContainer(bytes("<html>")).container).toBe("text");
    expect(sniffContainer(bytes("#EXTM3U\n#EXT-X")).container).toBe("text");
    expect(sniffContainer(bytes("ffconcat version 1.0")).container).toBe("text");
  });

  it("reports unknown for unrecognised bytes", () => {
    expect(sniffContainer(bytes([1, 2, 3, 4, 5, 6, 7, 8])).container).toBeNull();
  });

  it("compares the extension with the sniffed container", () => {
    const mp4 = sniffContainer(bytes([0, 0, 0, 0x20], "ftypisom"));
    expect(extensionMatches(".mp4", mp4)).toBe(true);
    expect(extensionMatches(".WEBM", mp4)).toBe(false);
    expect(extensionMatches(".bin", mp4)).toBeNull();
    expect(extensionMatches(".mp4", sniffContainer(bytes([9, 9, 9, 9])))).toBeNull();
    expect(extensionMatches(".mp4", sniffContainer(bytes("<html>")))).toBe(false);
  });
});

describe("ffprobe normalisation", () => {
  it("keeps unknown values null instead of a valid-looking 0", () => {
    expect(num("N/A")).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num("12.5")).toBe(12.5);
    expect(rational("0/0")).toBeNull();
    expect(rational("30000/1001")).toEqual({ num: 30000, den: 1001, value: 29.97003 });
    const info = parseProbe(
      JSON.stringify({
        format: { duration: "N/A" },
        streams: [{ index: 0, codec_type: "audio", sample_rate: "0" }],
      }),
    );
    expect(info.duration_s).toBeNull();
    expect(info.streams[0]).toMatchObject({ type: "audio", sample_rate_hz: null, channels: null });
  });

  it("applies rotation and sample aspect ratio to the display size", () => {
    const rotated = normaliseStream({
      index: 0,
      codec_type: "video",
      width: 1920,
      height: 1080,
      r_frame_rate: "30/1",
      avg_frame_rate: "30/1",
      side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
    });
    expect(rotated).toMatchObject({
      rotation_deg: 270,
      display_width: 1080,
      display_height: 1920,
      variable_frame_rate: false,
    });
    const legacy = normaliseStream({
      index: 0,
      codec_type: "video",
      width: 640,
      height: 480,
      tags: { rotate: "90" },
    });
    expect(legacy).toMatchObject({ rotation_deg: 270, display_width: 480, display_height: 640 });
    const anamorphic = normaliseStream({
      index: 0,
      codec_type: "video",
      width: 720,
      height: 576,
      sample_aspect_ratio: "64:45",
    });
    expect(anamorphic).toMatchObject({ display_width: 1024, display_height: 576 });
  });

  it("marks variable frame rate when the average differs from the base rate", () => {
    const vfr = normaliseStream({
      index: 0,
      codec_type: "video",
      width: 2,
      height: 2,
      r_frame_rate: "25/1",
      avg_frame_rate: "625/49",
    });
    expect(vfr).toMatchObject({ variable_frame_rate: true });
    const attached = normaliseStream({
      index: 1,
      codec_type: "video",
      disposition: { attached_pic: 1 },
    });
    expect(attached).toMatchObject({ attached_pic: true });
  });

  it("reads Matroska DURATION tags and ffprobe's bitrate estimate warning", () => {
    const mkv = normaliseStream({
      index: 0,
      codec_type: "audio",
      tags: { DURATION: "00:01:02.500000000" },
    });
    expect(mkv).toMatchObject({ duration_s: 62.5 });
    const json = JSON.stringify({ format: { duration: "6.0" }, streams: [] });
    expect(parseProbe(json).duration_estimated).toBe(false);
    expect(
      parseProbe(json, "[mp3 @ 0x1] Estimating duration from bitrate, this may be inaccurate")
        .duration_estimated,
    ).toBe(true);
  });
});

describe("local path guard", () => {
  it("refuses URLs and ffmpeg protocols", () => {
    for (const bad of [
      "http://x/a.mp4",
      "https://x",
      "concat:a.mp4|b.mp4",
      "pipe:0",
      "file:/etc/passwd",
      "subfile,,start,0:a",
    ])
      expect(() => assertLocalPath(bad), bad).toThrow(
        bad.startsWith("subfile") ? /local file path|URL/ : ValidationError,
      );
  });

  it("accepts plain, relative and Windows drive paths", () => {
    for (const ok of ["a.mp4", "./dir/a b.mp4", "C:\\media\\a.mp4", "/tmp/tên.mp4"])
      expect(() => assertLocalPath(ok)).not.toThrow();
  });

  it("passes ffmpeg the file protocol only", () => {
    expect(ffInput("/x/a.mp4")).toEqual(["-protocol_whitelist", "file", "-i", "file:/x/a.mp4"]);
    const args = analysisArgs("/x/a.mp4", {
      video: {
        streamIndex: 0,
        black: { minDurationS: 0.5, pixelThreshold: 0.1, pictureThreshold: 0.98 },
      },
    });
    expect(args).toContain("file:/x/a.mp4");
    expect(args.join(" ")).toContain("-map 0:0 -vf blackdetect=d=0.5:pix_th=0.1:pic_th=0.98");
    expect(args.slice(-4)).toEqual(["pipe:1", "-f", "null", "-"]);
  });
});

describe("AnalysisLogParser", () => {
  it("parses detector lines, closes open ranges and reads the ebur128 summary", () => {
    const p = new AnalysisLogParser();
    for (const line of [
      "[blackdetect @ 0x1] [info] black_start:0 black_end:1.04 black_duration:1.04",
      "[freezedetect @ 0x2] [info] lavfi.freezedetect.freeze_start: 2",
      "[freezedetect @ 0x2] [info] lavfi.freezedetect.freeze_duration: 1",
      "[freezedetect @ 0x2] [info] lavfi.freezedetect.freeze_end: 3",
      "[freezedetect @ 0x2] [info] lavfi.freezedetect.freeze_start: 8.5",
      "[silencedetect @ 0x3] [info] silence_start: -0.01",
      "[silencedetect @ 0x3] [info] silence_end: 1.5 | silence_duration: 1.51",
      "[Parsed_ebur128_1 @ 0x4] [info] Summary:",
      "  Integrated loudness:",
      "    I:         -21.8 LUFS",
      "    Threshold: -31.8 LUFS",
      "  Loudness range:",
      "    LRA:         3.2 LU",
      "  True peak:",
      "    Peak:      -inf dBFS",
    ])
      p.line(line);
    p.finish(10);
    expect(p.result.black).toEqual([{ start_s: 0, end_s: 1.04, duration_s: 1.04 }]);
    expect(p.result.freeze).toEqual([
      { start_s: 2, end_s: 3, duration_s: 1 },
      { start_s: 8.5, end_s: 10, duration_s: 1.5, open_end: true },
    ]);
    expect(p.result.silence).toEqual([{ start_s: 0, end_s: 1.5, duration_s: 1.5 }]);
    expect(p.result.loudness).toEqual({
      integrated_lufs: -21.8,
      loudness_range_lu: 3.2,
      true_peak_dbtp: null,
    });
  });

  it("counts every decode error but keeps a bounded number of lines", () => {
    const p = new AnalysisLogParser();
    for (let i = 0; i < 500; i++) p.line(`[h264 @ 0xabc] [error] error while decoding MB ${i} 1`);
    p.line(`[x] [info] ${"y".repeat(10_000)}`);
    expect(p.result.decode_error_count).toBe(500);
    expect(p.result.decode_errors).toHaveLength(20);
    expect(p.result.decode_errors[0]).toBe("[h264] [error] error while decoding MB 0 1");
    expect(p.result.log_tail.length).toBeLessThanOrEqual(15);
    expect(p.result.log_tail.at(-1)?.length).toBeLessThanOrEqual(2000);
  });
});

describe("expectation parsing", () => {
  it("parses ranges and aspect ratios", () => {
    expect(parseRange("0-1.5")).toEqual({ start: 0, end: 1.5 });
    expect(parseRange("2:3")).toEqual({ start: 2, end: 3 });
    expect(() => parseRange("3-2")).toThrow(ValidationError);
    expect(() => parseRange("abc")).toThrow(ValidationError);
    expect(parseAspect("16:9")).toBeCloseTo(1.7778, 3);
    expect(parseAspect("9/16")).toBeCloseTo(0.5625, 4);
    expect(parseAspect("1")).toBe(1);
    expect(() => parseAspect("0:9")).toThrow(ValidationError);
  });

  it("hashes objects independently of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }),
    );
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

const VIDEO_REPORT = {
  kind: "video",
  errors: [],
  streams: [
    { index: 0, type: "video" },
    { index: 1, type: "audio" },
  ],
  format: { duration_s: 10 },
  video: {
    index: 0,
    type: "video",
    display_width: 1920,
    display_height: 1080,
    rotation_deg: 0,
    avg_frame_rate: { num: 25, den: 1, value: 25 },
    r_frame_rate: { num: 25, den: 1, value: 25 },
  },
  audio: { index: 1, type: "audio" },
  wav_data: null,
} as unknown as InspectReport;

const analysis = (over: Record<string, unknown> = {}) =>
  ({
    decoded_s: 10,
    completed: true,
    timed_out: false,
    cancelled: false,
    exit_code: 0,
    decode_error_count: 0,
    decode_errors: [],
    black: [],
    freeze: [],
    silence: [],
    black_frames: [],
    loudness: { integrated_lufs: -20, loudness_range_lu: 2, true_peak_dbtp: -3 },
    log_tail: [],
    ...over,
  }) as never;

describe("judge", () => {
  const profile = builtinProfile("motion-graphics");
  const byId = (checks: Array<{ id: string }>, id: string) =>
    checks.find((c) => c.id === id) as Record<string, unknown>;

  it("fails a black gap with time and frame coordinates, unless it was declared intentional", () => {
    const a = analysis({ black: [{ start_s: 4, end_s: 5, duration_s: 1 }] });
    const failed = judge(VIDEO_REPORT, a, profile, {});
    expect(byId(failed.checks, "black")).toMatchObject({
      status: "fail",
      unit: "s",
      threshold: { min_duration_s: 0.5 },
      findings: [{ start_s: 4, end_s: 5, start_frame: 100, end_frame: 124 }],
    });
    const intended = judge(VIDEO_REPORT, a, profile, { allow_black: ["4-5"] });
    expect(byId(intended.checks, "black")).toMatchObject({
      status: "pass",
      findings: [{ intentional: true, allowed_by: "4-5" }],
    });
  });

  it("never passes what a stopped decode did not reach", () => {
    const { checks } = judge(
      VIDEO_REPORT,
      analysis({ completed: false, timed_out: true, decoded_s: 2 }),
      profile,
      {},
    );
    expect(byId(checks, "decode")).toMatchObject({ status: "unknown", reason: "decode timed out" });
    expect(byId(checks, "black")).toMatchObject({ status: "unknown" });
    expect(byId(checks, "clipping")).toMatchObject({ status: "unknown" });
  });

  it("detects truncation from decoded versus declared duration", () => {
    const { checks } = judge(VIDEO_REPORT, analysis({ decoded_s: 6 }), profile, {});
    expect(byId(checks, "decode")).toMatchObject({
      status: "fail",
      reason: expect.stringContaining("truncated"),
    });
  });

  it("states that A/V sync is not measured instead of inferring it from durations", () => {
    const { notMeasured } = judge(VIDEO_REPORT, analysis(), profile, { duration_s: 10 });
    expect(notMeasured.map((n) => n.id)).toContain("av_sync");
  });

  it("checks loudness only against a target the caller gives", () => {
    const without = judge(VIDEO_REPORT, analysis(), profile, {});
    expect(byId(without.checks, "loudness")).toBeUndefined();
    const withTarget = judge(VIDEO_REPORT, analysis(), profile, {
      loudness_lufs: -14,
      loudness_tolerance_lu: 1,
    });
    expect(byId(withTarget.checks, "loudness")).toMatchObject({
      status: "fail",
      measured: { integrated_lufs: -20 },
    });
  });

  it("rejects media the profile does not judge", () => {
    const { checks } = judge(VIDEO_REPORT, analysis(), builtinProfile("thumbnail"), {});
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      id: "media_kind",
      status: "fail",
      reason: expect.stringContaining("thumbnail judges image"),
    });
  });
});

describe("profiles", () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = (body: unknown) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-profile-"));
    const file = path.join(dir, "p.json");
    fs.writeFileSync(file, JSON.stringify(body));
    return file;
  };

  it("versions every built-in profile and keeps platform loudness targets out", () => {
    for (const p of Object.values(BUILTIN_PROFILES)) {
      expect(p.version).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(p.checks)).not.toMatch(/lufs/i);
    }
    expect(() => builtinProfile("youtube")).toThrow(/Unknown profile/);
  });

  it("loads a custom profile that extends a built-in one", () => {
    const p = loadProfileFile(
      write({
        id: "brand-intro",
        version: 3,
        extends: "motion-graphics",
        checks: {
          freeze: null,
          black: {
            min_duration_s: 0.2,
            pixel_threshold: 0.1,
            picture_threshold: 0.98,
            severity: "warning",
          },
        },
      }),
    );
    expect(p).toMatchObject({
      id: "brand-intro",
      version: 3,
      media: "video",
      checks: { freeze: null, black: { severity: "warning" }, silence: { min_duration_s: 2 } },
    });
  });

  it("rejects unknown keys, built-in ids and missing media", () => {
    expect(() =>
      loadProfileFile(write({ id: "x", version: 1, media: "video", checks: { blur: {} } })),
    ).toThrow(/Invalid profile/);
    expect(() => loadProfileFile(write({ id: "audio", version: 2, extends: "audio" }))).toThrow(
      /built-in/,
    );
    expect(() => loadProfileFile(write({ id: "x", version: 1 }))).toThrow(/media/);
  });
});

describe("WAV data size", () => {
  const wav = (dataSize: number, extra: number[] = []) => {
    const b = Buffer.alloc(44 + extra.length);
    b.write("RIFF", 0, "latin1");
    b.write("WAVE", 8, "latin1");
    b.write("fmt ", 12, "latin1");
    b.writeUInt32LE(16, 16);
    b.write("data", 36, "latin1");
    b.writeUInt32LE(dataSize, 40);
    return b;
  };

  it("compares the data chunk's declared size with the bytes after it", () => {
    expect(wavDataSize(wav(1000), 44 + 1000)).toEqual({
      declared_bytes: 1000,
      present_bytes: 1000,
    });
    expect(wavDataSize(wav(1000), 44 + 400)).toEqual({ declared_bytes: 1000, present_bytes: 400 });
  });

  it("declares nothing for streaming placeholders, other formats or a chunk past the head", () => {
    expect(wavDataSize(wav(0), 500)).toBeNull();
    expect(wavDataSize(wav(0xffffffff), 500)).toBeNull();
    expect(wavDataSize(Buffer.from("ID3\u0003\u0000\u0000\u0000\u0000"), 8)).toBeNull();
    expect(wavDataSize(wav(1000).subarray(0, 30), 2000)).toBeNull();
  });
});
