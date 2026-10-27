/**
 * `media inspect` / `verify` / `frames` / `check-receipt` against real files
 * rendered by ffmpeg's lavfi sources. Skipped where ffmpeg is not installed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractFrames } from "../../../../src/commands/media/media-frames.js";
import { inspectMedia } from "../../../../src/commands/media/media-inspect.js";
import { checkReceipt } from "../../../../src/commands/media/media-receipt.js";
import { type VerifyReceipt, verifyMedia } from "../../../../src/commands/media/media-verify.js";
import { builtinProfile, loadProfileFile } from "../../../../src/commands/media/verify-profiles.js";

const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

let dir: string;
const f = (name: string) => path.join(dir, name);
const ff = (...args: string[]) =>
  execFileSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args]);

const check = (r: VerifyReceipt, id: string) => {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id} in ${r.checks.map((x) => x.id).join(",")}`);
  return c;
};
const tempEntries = (prefix: string) =>
  fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(prefix));

describe.skipIf(!hasFfmpeg)("media quality with ffmpeg", { timeout: 60_000 }, () => {
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-mq-"));
    // 1 s black, then 3 s of moving test pattern; 4 s of tone. 16:9.
    ff(
      ...["-f", "lavfi", "-i", "color=black:s=320x180:r=25:d=1"],
      ...["-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=3"],
      ...["-f", "lavfi", "-i", "sine=f=440:d=4"],
      ...["-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a"],
      ...["-pix_fmt", "yuv420p", "-movflags", "+faststart", f("t.mp4")],
    );
    // 9:16, NTSC rational rate, no audio.
    ff(
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=180x320:r=30000/1001:d=2",
      "-pix_fmt",
      "yuv420p",
      f("portrait.mp4"),
    );
    // 1:1 with audio.
    ff(
      ...["-f", "lavfi", "-i", "testsrc2=s=240x240:r=24:d=2", "-f", "lavfi", "-i", "sine=d=2"],
      ...["-pix_fmt", "yuv420p", "-shortest", f("square.mp4")],
    );
    // 25 fps then 10 fps in one stream: variable frame rate.
    ff(
      ...[
        "-filter_complex",
        "testsrc2=s=160x90:r=25:d=1[a];testsrc2=s=160x90:r=10:d=1[b];[a][b]concat=n=2:v=1:a=0[v]",
      ],
      ...["-map", "[v]", "-fps_mode", "passthrough", f("vfr.mp4")],
    );
    // Display matrix rotated 90°: stored 320x180, shown 180x320.
    ff("-display_rotation", "90", "-i", f("t.mp4"), "-c", "copy", f("rot.mp4"));
    ff("-i", f("t.mp4"), "-c:v", "mpeg4", "-q:v", "5", "-c:a", "copy", f("t2.mp4"));
    ff("-f", "lavfi", "-i", "sine=f=440:d=2,volume=20dB", f("clip.wav"));
    ff("-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "3", f("silent.wav"));
    ff("-f", "lavfi", "-i", "color=black:s=64x64", "-frames:v", "1", f("black.png"));
    ff("-f", "lavfi", "-i", "testsrc2=s=64x64", "-frames:v", "1", f("ok.png"));
    fs.copyFileSync(f("t.mp4"), f("wrong.webm"));
    const full = fs.readFileSync(f("t.mp4"));
    fs.writeFileSync(f("trunc.mp4"), full.subarray(0, Math.floor(full.length * 0.6)));
    fs.writeFileSync(f("error.mp4"), "<html><body>403 Forbidden</body></html>\n");
    fs.mkdirSync(f("thư mục có dấu cách"));
    fs.copyFileSync(f("square.mp4"), f("thư mục có dấu cách/tệp vuông.mp4"));
    // To image2, `thumb%03d.png` names `thumb000.png`: a blank file beside a good one.
    fs.copyFileSync(f("black.png"), f("thumb%03d.png"));
    fs.copyFileSync(f("ok.png"), f("thumb000.png"));
    // 2 s of picture under 4 s of sound.
    ff(
      ...["-f", "lavfi", "-i", "testsrc2=s=160x90:r=25:d=2", "-f", "lavfi", "-i", "sine=d=4"],
      ...["-pix_fmt", "yuv420p", f("short-video.mp4")],
    );
    // VBR mp3 without a Xing header: ffprobe estimates its duration from the first frames.
    ff(
      ...["-f", "lavfi", "-i", "anoisesrc=d=6:a=0.05,volume='if(lt(t,3),1,0.01)':eval=frame"],
      ...["-c:a", "libmp3lame", "-q:a", "2", "-write_xing", "0", f("vbr.mp3")],
    );
    // An mp3 whose Xing header declares 6 s, cut to its first half.
    ff("-f", "lavfi", "-i", "sine=d=6", "-c:a", "libmp3lame", f("xing.mp3"));
    const mp3 = fs.readFileSync(f("xing.mp3"));
    fs.writeFileSync(f("trunc.mp3"), mp3.subarray(0, Math.floor(mp3.length / 2)));
    // Matroska keeps stream lengths only in DURATION tags.
    ff("-i", f("short-video.mp4"), "-c", "copy", f("short-video.mkv"));
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("inspect", () => {
    it("reports container, rational timebase, audio and a clean decode", async () => {
      const r = await inspectMedia(f("t.mp4"), { decode: true });
      expect(r.ok).toBe(true);
      expect(r.kind).toBe("video");
      expect(r.sniff).toMatchObject({ container: "mp4", extension_matches: true });
      expect(r.source.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.video).toMatchObject({ width: 320, height: 180, rotation_deg: 0 });
      expect(r.video?.avg_frame_rate).toMatchObject({ num: 25, den: 1 });
      expect(r.video?.time_base).toMatch(/^\d+\/\d+$/);
      expect(r.audio?.sample_rate_hz).toBeGreaterThan(0);
      expect(r.format?.duration_s).toBeCloseTo(4, 0);
      expect(r.decode).toMatchObject({ completed: true, error_count: 0 });
    });

    it("keeps NTSC rates rational and marks a missing audio stream as null", async () => {
      const r = await inspectMedia(f("portrait.mp4"), {});
      expect(r.video?.avg_frame_rate).toMatchObject({ num: 30000, den: 1001 });
      expect(r.video?.avg_frame_rate?.value).toBeCloseTo(29.97, 2);
      expect(r.audio).toBeNull();
    });

    it("flags variable frame rate", async () => {
      const r = await inspectMedia(f("vfr.mp4"), {});
      expect(r.sniff.container).toBe("mp4");
      expect(r.video?.variable_frame_rate).toBe(true);
    });

    it("applies the display matrix to the shown size", async () => {
      const r = await inspectMedia(f("rot.mp4"), {});
      expect(r.video).toMatchObject({
        width: 320,
        height: 180,
        rotation_deg: 90,
        display_width: 180,
        display_height: 320,
      });
    });

    it("reports an extension that does not match the bytes", async () => {
      const r = await inspectMedia(f("wrong.webm"), {});
      expect(r.sniff).toMatchObject({
        container: "mp4",
        extension: ".webm",
        extension_matches: false,
      });
    });

    it("never hands a text error page to ffprobe", async () => {
      const r = await inspectMedia(f("error.mp4"), {});
      expect(r.ok).toBe(false);
      expect(r.kind).toBeNull();
      expect(r.sniff.container).toBe("text");
      expect(r.errors.join(" ")).toMatch(/not passed to ffprobe/);
    });

    it("reads Unicode paths with spaces, and symlinks to the real file", async () => {
      const target = f("thư mục có dấu cách/tệp vuông.mp4");
      const r = await inspectMedia(target, {});
      expect(r.ok).toBe(true);
      expect(r.video).toMatchObject({ width: 240, height: 240 });
      if (process.platform === "win32") return;
      fs.symlinkSync(target, f("link.mp4"));
      const viaLink = await inspectMedia(f("link.mp4"), {});
      expect(viaLink.source).toMatchObject({ symlink: true, sha256: r.source.sha256 });
    });

    it("hashes a large non-media file by streaming and reports it as unreadable", async () => {
      const big = f("big.mp4");
      fs.writeFileSync(big, Buffer.alloc(48 * 1024 * 1024, 7));
      const r = await inspectMedia(big, {});
      expect(r.source.bytes).toBe(48 * 1024 * 1024);
      expect(r.ok).toBe(false);
      expect(r.kind).toBeNull();
      fs.rmSync(big);
    });
  });

  describe("verify", () => {
    it("fails black and frozen opening seconds on camera footage, with timestamps and frames", async () => {
      const r = await verifyMedia(f("t.mp4"), { profile: builtinProfile("camera-footage") });
      expect(r.status).toBe("fail");
      const black = check(r, "black");
      expect(black.status).toBe("fail");
      expect(black.findings?.[0]).toMatchObject({ start_s: 0 });
      expect(black.findings?.[0]?.end_s).toBeCloseTo(1, 1);
      expect(black.findings?.[0]?.start_frame).toBe(0);
      expect(black.threshold).toBeDefined();
      expect(r.coverage).toMatchObject({ completed: true, model_reviewed: false });
      expect(r.timebase.frame_rate).toBe("25/1");
      expect(r.not_measured.map((n) => n.id)).toContain("av_sync");
    });

    it("passes when the black opening is declared intentional and expectations match", async () => {
      const r = await verifyMedia(f("t.mp4"), {
        profile: builtinProfile("motion-graphics"),
        expect: {
          allow_black: ["0-1"],
          allow_freeze: ["0-1"],
          duration_s: 4,
          aspect_ratio: "16:9",
        },
      });
      expect(r.status).toBe("pass");
      expect(check(r, "black").findings?.[0]).toMatchObject({
        intentional: true,
        allowed_by: "0-1",
      });
      expect(r.summary.intentional).toBeGreaterThan(0);
      expect(check(r, "duration").status).toBe("pass");
      expect(check(r, "aspect_ratio").status).toBe("pass");
    });

    it("checks 9:16, 1:1 and rotated aspect ratios against the displayed size", async () => {
      const mg = builtinProfile("motion-graphics");
      const portrait = await verifyMedia(f("portrait.mp4"), {
        profile: mg,
        expect: { aspect_ratio: "9:16" },
      });
      expect(check(portrait, "aspect_ratio").status).toBe("pass");
      const square = await verifyMedia(f("square.mp4"), {
        profile: mg,
        expect: { aspect_ratio: "1:1" },
      });
      expect(check(square, "aspect_ratio").status).toBe("pass");
      const rot = await verifyMedia(f("rot.mp4"), {
        profile: mg,
        expect: { aspect_ratio: "9:16", allow_black: ["0-1"], allow_freeze: ["0-1"] },
      });
      expect(check(rot, "aspect_ratio").status).toBe("pass");
      const wrong = await verifyMedia(f("square.mp4"), {
        profile: mg,
        expect: { aspect_ratio: "16:9" },
      });
      expect(check(wrong, "aspect_ratio").status).toBe("fail");
    });

    it("fails a truncated file", async () => {
      const r = await verifyMedia(f("trunc.mp4"), { profile: builtinProfile("motion-graphics") });
      expect(r.status).toBe("fail");
      expect(check(r, "decode").status).toBe("fail");
    });

    it("judges audio files: clipping fails, digital silence warns, loudness only on request", async () => {
      const audio = builtinProfile("audio");
      const clip = await verifyMedia(f("clip.wav"), { profile: audio });
      expect(check(clip, "clipping").status).toBe("fail");
      expect(clip.checks.some((c) => c.id === "loudness")).toBe(false);
      const silent = await verifyMedia(f("silent.wav"), {
        profile: audio,
        expect: { loudness_lufs: -23 },
      });
      expect(check(silent, "silence").status).toBe("warn");
      expect(check(silent, "loudness").status).toBe("fail");
      const allowed = await verifyMedia(f("silent.wav"), {
        profile: audio,
        expect: { allow_silence: ["0-3"] },
      });
      expect(check(allowed, "silence").status).toBe("pass");
    });

    it("refuses a profile meant for another media kind", async () => {
      const r = await verifyMedia(f("t.mp4"), { profile: builtinProfile("thumbnail") });
      expect(r.status).toBe("fail");
      expect(check(r, "media_kind").status).toBe("fail");
      const noAudio = await verifyMedia(f("portrait.mp4"), { profile: builtinProfile("audio") });
      expect(check(noAudio, "media_kind").status).toBe("fail");
    });

    it("judges thumbnails as blank or not", async () => {
      const thumb = builtinProfile("thumbnail");
      expect((await verifyMedia(f("black.png"), { profile: thumb })).status).toBe("fail");
      expect((await verifyMedia(f("ok.png"), { profile: thumb })).status).toBe("pass");
    });

    it("reports incomplete, never pass, when decoding times out", async () => {
      const r = await verifyMedia(f("t.mp4"), {
        profile: builtinProfile("motion-graphics"),
        timeoutMs: 1,
      });
      expect(r.status).toBe("incomplete");
      expect(r.coverage.completed).toBe(false);
      expect(r.summary.unknown).toBeGreaterThan(0);
    });

    it("does not start reading a file once cancelled", async () => {
      const ac = new AbortController();
      ac.abort();
      await expect(
        verifyMedia(f("t.mp4"), { profile: builtinProfile("motion-graphics"), signal: ac.signal }),
      ).rejects.toThrow(/abort/i);
    });

    it("reports incomplete when cancelled mid-run", async () => {
      const started = f("rule-started");
      const rule = f("slow-rule.mjs");
      fs.writeFileSync(
        rule,
        `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(started)}, "");\nsetTimeout(() => {}, 20000);\n`,
      );
      const ac = new AbortController();
      const run = verifyMedia(f("square.mp4"), {
        profile: builtinProfile("motion-graphics"),
        rules: [rule],
        signal: ac.signal,
      });
      while (!fs.existsSync(started)) await new Promise((r) => setTimeout(r, 25));
      ac.abort();
      const r = await run;
      expect(r.status).toBe("incomplete");
      expect(check(r, "rule:slow-rule.mjs").status).toBe("unknown");
    });
  });

  describe("verdicts on real-world shapes", () => {
    it("judges the file named, not an image2 pattern match, when its name holds a %", async () => {
      const r = await verifyMedia(f("thumb%03d.png"), { profile: builtinProfile("thumbnail") });
      expect(r.status).toBe("fail");
      expect(check(r, "blank_image").status).toBe("fail");
      const probe = await inspectMedia(f("thumb%03d.png"), {});
      expect(probe.source.sha256).toBe((await inspectMedia(f("black.png"), {})).source.sha256);
    });

    it("fails a picture that ends seconds before its sound", async () => {
      const r = await verifyMedia(f("short-video.mp4"), {
        profile: builtinProfile("camera-footage"),
      });
      expect(r.status).toBe("fail");
      expect(check(r, "track_lengths")).toMatchObject({ status: "fail", severity: "error" });
    });

    it("reads stream lengths from Matroska's DURATION tags", async () => {
      const r = await verifyMedia(f("short-video.mkv"), {
        profile: builtinProfile("camera-footage"),
      });
      expect(check(r, "track_lengths").status).toBe("fail");
      const audioOnly = await verifyMedia(f("short-video.mkv"), {
        profile: builtinProfile("audio"),
      });
      expect(check(audioOnly, "decode").status).toBe("pass");
      const m = await extractFrames(f("short-video.mkv"), { outDir: f("mkv-frames"), count: 3 });
      expect(Math.max(...m.frames.map((x) => x.requested_s))).toBeLessThan(2);
    });

    it("fails an mp3 cut short of the length its Xing header declares", async () => {
      expect(
        check(await verifyMedia(f("xing.mp3"), { profile: builtinProfile("audio") }), "decode")
          .status,
      ).toBe("pass");
      const r = await verifyMedia(f("trunc.mp3"), { profile: builtinProfile("audio") });
      expect(r.status).toBe("fail");
      expect(check(r, "decode").status).toBe("fail");
    });

    it("does not call a file truncated from durations it did not decode or that are estimates", async () => {
      const audioOnly = await verifyMedia(f("short-video.mp4"), {
        profile: builtinProfile("audio"),
      });
      expect(check(audioOnly, "decode").status).toBe("pass");
      const mp3 = await verifyMedia(f("vbr.mp3"), { profile: builtinProfile("audio") });
      expect(check(mp3, "decode").status).toBe("pass");
      expect(check(mp3, "decode").measured).toMatchObject({ declared_duration_estimated: true });
    });

    it("counts a declared black hold as an intended freeze too", async () => {
      const r = await verifyMedia(f("t.mp4"), {
        profile: builtinProfile("camera-footage"),
        expect: { allow_black: ["0-1"] },
      });
      expect(check(r, "black").status).toBe("pass");
      expect(check(r, "freeze").status).toBe("pass");
    });
  });

  describe("cache", () => {
    it("hits for the same bytes and inputs and misses when source, profile or rule change", async () => {
      const cacheDir = f("cache");
      const media = f("cached.mp4");
      fs.copyFileSync(f("square.mp4"), media);
      const rule = f("rule.mjs");
      fs.writeFileSync(
        rule,
        'process.stdout.write(JSON.stringify({id:"r",version:1,status:"pass"}))\n',
      );
      const base = { profile: builtinProfile("motion-graphics"), cacheDir, rules: [rule] };
      const first = await verifyMedia(media, base);
      expect(first.cache).toMatchObject({ hit: false });
      const second = await verifyMedia(media, base);
      expect(second.cache).toEqual({ key: first.cache?.key, hit: true });

      const strict = await verifyMedia(media, {
        ...base,
        profile: builtinProfile("camera-footage"),
      });
      expect(strict.cache?.key).not.toBe(first.cache?.key);

      fs.writeFileSync(
        rule,
        'process.stdout.write(JSON.stringify({id:"r",version:2,status:"pass"}))\n',
      );
      const ruleChanged = await verifyMedia(media, base);
      expect(ruleChanged.cache?.hit).toBe(false);
      expect(ruleChanged.cache?.key).not.toBe(first.cache?.key);

      fs.copyFileSync(f("portrait.mp4"), media);
      const sourceChanged = await verifyMedia(media, base);
      expect(sourceChanged.cache?.hit).toBe(false);
      expect(sourceChanged.source.sha256).not.toBe(first.source.sha256);
      expect(fs.readdirSync(cacheDir).every((n) => n.endsWith(".json"))).toBe(true);
    });

    it("does not cache an incomplete receipt", async () => {
      const cacheDir = f("cache-incomplete");
      const r = await verifyMedia(f("t.mp4"), {
        profile: builtinProfile("motion-graphics"),
        cacheDir,
        timeoutMs: 1,
      });
      expect(r.status).toBe("incomplete");
      expect(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []).toEqual([]);
    });
  });

  describe("custom rules", () => {
    it("run with only PATH in a temp cwd that is removed, and their verdict becomes a check", async () => {
      const rule = f("env-rule.mjs");
      fs.writeFileSync(
        rule,
        [
          'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{',
          "const input=JSON.parse(s);",
          'const keys=Object.keys(process.env).filter(k=>k!=="SystemRoot"&&!k.startsWith("LC_")&&k!=="__CF_USER_TEXT_ENCODING").sort();',
          'process.stdout.write(JSON.stringify({id:"env-probe",version:"1",',
          'status:input.inspect.video.width>=300?"pass":"fail",',
          "message:JSON.stringify({keys,cwd:process.cwd(),schema:input.schema})}));});",
        ].join("\n"),
      );
      process.env.MULTIX_TEST_SECRET = "do-not-leak";
      const before = tempEntries("multix-rule-");
      try {
        const r = await verifyMedia(f("square.mp4"), {
          profile: builtinProfile("motion-graphics"),
          rules: [rule],
        });
        const c = check(r, "rule:env-probe");
        expect(c.status).toBe("fail");
        const seen = JSON.parse(c.reason ?? "{}");
        expect(seen.keys).toEqual(["PATH"]);
        expect(seen.schema).toBe("multix.media-rule-input/v1");
        expect(fs.existsSync(seen.cwd)).toBe(false);
        expect(r.rules[0]).toMatchObject({ id: "env-probe", version: "1" });
        expect(r.rules[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        Reflect.deleteProperty(process.env, "MULTIX_TEST_SECRET");
      }
      expect(tempEntries("multix-rule-")).toEqual(before);
    });

    it("turn a hung, crashing or malformed rule into an unknown check", async () => {
      const hang = f("hang.mjs");
      fs.writeFileSync(hang, "setInterval(() => {}, 1000);\n");
      const crash = f("crash.mjs");
      fs.writeFileSync(crash, "process.exit(3);\n");
      const bad = f("bad.mjs");
      fs.writeFileSync(bad, 'process.stdout.write("{\\"id\\":\\"Bad Id\\"}");\n');
      const r = await verifyMedia(f("square.mp4"), {
        profile: builtinProfile("motion-graphics"),
        rules: [hang, crash, bad],
        ruleTimeoutMs: 1500,
      });
      expect(r.status).toBe("incomplete");
      const reasons = r.rules.map((x) => x.error);
      expect(reasons[0]).toMatch(/timed out/);
      expect(reasons[1]).toMatch(/exited with code 3/);
      expect(reasons[2]).toMatch(/output invalid/);
    });

    it.skipIf(process.platform === "win32")(
      "time out even when a child of the rule holds its stdout open, and leave no child behind",
      async () => {
        const marker = `multix-rule-orphan-${process.pid}`;
        const rule = f("spawner.mjs");
        fs.writeFileSync(
          rule,
          `import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "${marker}"], { stdio: "inherit" });
setTimeout(() => {}, 60000);
`,
        );
        const started = Date.now();
        const r = await verifyMedia(f("square.mp4"), {
          profile: builtinProfile("motion-graphics"),
          rules: [rule],
          ruleTimeoutMs: 1000,
        });
        expect(Date.now() - started).toBeLessThan(15_000);
        expect(r.rules[0]?.error).toMatch(/timed out/);
        const ps = spawnSync("ps", ["-eo", "args"], { encoding: "utf8" }).stdout;
        expect(ps).not.toContain(marker);
      },
    );
  });

  describe("custom profile files", () => {
    it("extend a built-in profile and carry their own id and version", async () => {
      const file = f("brand.json");
      fs.writeFileSync(
        file,
        JSON.stringify({
          id: "brand-intro",
          version: 3,
          extends: "motion-graphics",
          checks: { black: null },
        }),
      );
      const profile = loadProfileFile(file);
      const r = await verifyMedia(f("t.mp4"), { profile, profileOrigin: "file" });
      expect(r.profile).toMatchObject({ id: "brand-intro", version: 3, origin: "file" });
      expect(r.checks.some((c) => c.id === "black")).toBe(false);
      expect(check(r, "freeze").status).not.toBe("unknown");
    });
  });

  describe("receipts", () => {
    it("match the exact bytes verified and reject the transcoded output", async () => {
      const r = await verifyMedia(f("t.mp4"), {
        profile: builtinProfile("motion-graphics"),
        expect: { allow_black: ["0-1"], allow_freeze: ["0-1"] },
      });
      const receipt = f("receipt.json");
      fs.writeFileSync(receipt, JSON.stringify({ schema: "multix.result/v1", ok: true, data: r }));
      expect(await checkReceipt(receipt, f("t.mp4"))).toMatchObject({
        ok: true,
        hash_matches: true,
        receipt_status: "pass",
      });
      for (const bad of [null, { schema: "multix.media-verify/v1", status: "pass" }]) {
        fs.writeFileSync(f("bad-receipt.json"), JSON.stringify(bad));
        await expect(checkReceipt(f("bad-receipt.json"), f("t.mp4"))).rejects.toThrow(
          /Invalid receipt/,
        );
      }
      const other = await checkReceipt(receipt, f("t2.mp4"));
      expect(other).toMatchObject({ ok: false, hash_matches: false });
      expect(other.reason).toMatch(/verify it again|differ/i);
    });
  });

  describe("frames", () => {
    it("writes sampled frames, a contact sheet and a manifest tied to the source hash", async () => {
      const outDir = f("frames out");
      const before = fs.readdirSync(dir).filter((n) => n.startsWith(".frames-"));
      const m = await extractFrames(f("t.mp4"), { outDir, count: 4, sheet: true });
      expect(m.schema).toBe("multix.media-frames/v1");
      expect(m.frames).toHaveLength(4);
      expect(m.coverage).toEqual({
        sampled_frames: 4,
        local_extraction: true,
        model_reviewed: false,
      });
      expect(m.stream.time_base).toMatch(/^\d+\/\d+$/);
      for (const fr of m.frames) expect(fs.existsSync(path.join(outDir, fr.file))).toBe(true);
      expect(m.sheet && fs.existsSync(path.join(outDir, m.sheet.file))).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "frames.json"), "utf8"));
      expect(manifest.source.sha256).toBe((await inspectMedia(f("t.mp4"), {})).source.sha256);
      expect(fs.readdirSync(outDir).filter((n) => n.startsWith(".frames-"))).toEqual([]);
      expect(fs.readdirSync(dir).filter((n) => n.startsWith(".frames-"))).toEqual(before);
      await expect(extractFrames(f("t.mp4"), { outDir, count: 2 })).rejects.toThrow(/already/i);
    });

    it("samples only the picture's span and writes into a directory whose name holds a %", async () => {
      const outDir = f("frames 100%");
      const m = await extractFrames(f("short-video.mp4"), { outDir, count: 3, sheet: true });
      expect(m.frames).toHaveLength(3);
      expect(Math.max(...m.frames.map((x) => x.requested_s))).toBeLessThan(2);
      expect(fs.readdirSync(outDir).sort()).toEqual([
        "frame-001.png",
        "frame-002.png",
        "frame-003.png",
        "frames.json",
        "sheet.png",
      ]);
    });
  });
});
