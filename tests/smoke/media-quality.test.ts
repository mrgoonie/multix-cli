/**
 * Smoke tests for the offline media checks through dist/cli.js: the
 * multix.result/v1 envelope, exit codes, the missing-ffmpeg blocker and
 * the receipt round trip.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedEnv } from "./child-env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../dist/cli.js");
const SPAWN_TIMEOUT = 30_000;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

let tmp: string;
const run = (args: string[], env: NodeJS.ProcessEnv = isolatedEnv(tmp)) =>
  execa("node", [CLI, ...args], {
    cwd: tmp,
    env,
    extendEnv: false,
    reject: false,
    timeout: SPAWN_TIMEOUT - 1_000,
  });
const envelope = (stdout: string) => JSON.parse(stdout);

describe("media inspect/verify (smoke)", { timeout: SPAWN_TIMEOUT }, () => {
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-mq-smoke-"));
    fs.writeFileSync(path.join(tmp, "note.mp4"), "not media\n");
    // 1 s black, then 1 s of test pattern.
    if (hasFfmpeg)
      execFileSync("ffmpeg", [
        ...["-nostdin", "-loglevel", "error", "-y"],
        ...["-f", "lavfi", "-i", "color=black:s=160x90:r=25:d=1"],
        ...["-f", "lavfi", "-i", "testsrc2=s=160x90:r=25:d=1"],
        ...["-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]"],
        ...["-pix_fmt", "yuv420p", path.join(tmp, "clip.mp4")],
      ]);
  });
  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("lists the versioned built-in profiles", async () => {
    const res = await run(["media", "profiles", "--json"]);
    expect(res.exitCode).toBe(0);
    const out = envelope(res.stdout);
    expect(out).toMatchObject({ schema: "multix.result/v1", ok: true });
    expect(out.data.map((p: { id: string }) => p.id)).toEqual([
      "motion-graphics",
      "camera-footage",
      "thumbnail",
      "audio",
    ]);
  });

  it("refuses URLs before reading anything", async () => {
    const res = await run([
      "media",
      "verify",
      "https://example.com/a.mp4",
      "--profile",
      "audio",
      "--json",
    ]);
    expect(res.exitCode).toBe(2);
    expect(envelope(res.stdout).error.code).toBe("INVALID_INPUT");
  });

  it.skipIf(process.platform === "win32")(
    "stops with BINARY_MISSING and an install hint when ffmpeg is not on PATH",
    async () => {
      const bin = path.join(tmp, "bin-node-only");
      fs.mkdirSync(bin, { recursive: true });
      fs.symlinkSync(process.execPath, path.join(bin, "node"));
      const env = { ...isolatedEnv(tmp), PATH: bin };
      const res = await execa(
        path.join(bin, "node"),
        [CLI, "media", "verify", "note.mp4", "--profile", "audio", "--json"],
        {
          cwd: tmp,
          env,
          extendEnv: false,
          reject: false,
          timeout: SPAWN_TIMEOUT - 1_000,
        },
      );
      const out = envelope(res.stdout);
      expect(out.ok).toBe(false);
      expect(out.data).toBeUndefined();
      expect(out.error.code).toBe("BINARY_MISSING");
      expect(out.error.message).toMatch(/install ffmpeg/);
    },
  );

  describe.skipIf(!hasFfmpeg)("with ffmpeg", () => {
    it("exits non-zero with the failed receipt as data", async () => {
      const res = await run([
        "media",
        "verify",
        "clip.mp4",
        "--profile",
        "motion-graphics",
        "--json",
      ]);
      expect(res.exitCode).not.toBe(0);
      const out = envelope(res.stdout);
      expect(out.ok).toBe(false);
      expect(out.data).toMatchObject({ schema: "multix.media-verify/v1", status: "fail" });
      expect(out.data.checks.find((c: { id: string }) => c.id === "black").status).toBe("fail");
    });

    it("writes a passing receipt that check-receipt ties to the exact bytes", async () => {
      const res = await run([
        ...["media", "verify", "clip.mp4", "--profile", "motion-graphics"],
        ...[
          "--allow-black",
          "0-1",
          "--allow-freeze",
          "0-1",
          "--receipt-out",
          "receipt.json",
          "--json",
        ],
      ]);
      expect(res.exitCode).toBe(0);
      expect(envelope(res.stdout).data.status).toBe("pass");
      const ok = await run(["media", "check-receipt", "receipt.json", "clip.mp4", "--json"]);
      expect(ok.exitCode).toBe(0);
      expect(envelope(ok.stdout).data).toMatchObject({ ok: true, hash_matches: true });
      const bad = await run(["media", "check-receipt", "receipt.json", "note.mp4", "--json"]);
      expect(bad.exitCode).not.toBe(0);
      expect(envelope(bad.stdout).data).toMatchObject({ ok: false, hash_matches: false });
      // A receipt from an older verify engine still vouches, with a warning on stderr and in the envelope.
      const receipt = JSON.parse(fs.readFileSync(path.join(tmp, "receipt.json"), "utf8"));
      const data = receipt.data ?? receipt;
      data.engine.id = "multix-media-verify/1";
      fs.writeFileSync(path.join(tmp, "old-receipt.json"), JSON.stringify(receipt));
      const warning = /the receipt was made by verify engine multix-media-verify\/1/;
      const aged = await run(["media", "check-receipt", "old-receipt.json", "clip.mp4"]);
      expect(aged.exitCode).toBe(0);
      expect(aged.stdout).toMatch(/OK {2}receipt/);
      expect(aged.stderr).toMatch(warning);
      const agedJson = await run([
        ...["media", "check-receipt", "old-receipt.json", "clip.mp4", "--json"],
      ]);
      const out = envelope(agedJson.stdout);
      expect(out.ok).toBe(true);
      expect(out.data.engine.current_matches).toBe(false);
      expect(JSON.stringify(out.warnings)).toMatch(warning);
    });

    it("reads an empty number flag as invalid, not 0", async () => {
      const res = await run([
        "media",
        "verify",
        "clip.mp4",
        "--profile",
        "audio",
        "--loudness",
        "",
        "--json",
      ]);
      expect(res.exitCode).toBe(2);
      expect(envelope(res.stdout).error.message).toMatch(/--loudness/);
    });

    it.skipIf(process.platform === "win32")(
      "removes its staging directory when interrupted with Ctrl-C",
      async () => {
        const out = path.join(tmp, "interrupted");
        const child = execa(
          "node",
          [CLI, "media", "frames", "clip.mp4", "--output-dir", out, "--count", "100"],
          {
            cwd: tmp,
            env: isolatedEnv(tmp),
            extendEnv: false,
            reject: false,
            timeout: SPAWN_TIMEOUT - 1_000,
          },
        );
        const staged = () =>
          fs.existsSync(out) ? fs.readdirSync(out).filter((n) => n.startsWith(".frames-")) : [];
        const deadline = Date.now() + 10_000;
        while (staged().length === 0 && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 25));
        expect(staged()).toHaveLength(1);
        child.kill("SIGINT");
        const res = await child;
        expect(res.exitCode).toBe(130);
        expect(res.stderr).toContain("code: CANCELLED (exit 130 with --json)");
        expect(staged()).toEqual([]);
        expect(fs.readdirSync(out).filter((n) => n.endsWith(".png"))).toEqual([]);
      },
    );

    it.skipIf(process.platform === "win32")(
      "reports a SIGTERM as CANCELLED with the signal's exit code in --json",
      async () => {
        const out = path.join(tmp, "terminated");
        const child = execa(
          "node",
          [CLI, "media", "frames", "clip.mp4", "--output-dir", out, "--count", "100", "--json"],
          {
            cwd: tmp,
            env: isolatedEnv(tmp),
            extendEnv: false,
            reject: false,
            timeout: SPAWN_TIMEOUT - 1_000,
          },
        );
        const staged = () =>
          fs.existsSync(out) ? fs.readdirSync(out).filter((n) => n.startsWith(".frames-")) : [];
        const deadline = Date.now() + 10_000;
        while (staged().length === 0 && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 25));
        expect(staged()).toHaveLength(1);
        child.kill("SIGTERM");
        const res = await child;
        expect(res.exitCode).toBe(143);
        const report = envelope(res.stdout);
        expect(report).toMatchObject({ ok: false, exit_code: 143 });
        expect(report.error).toMatchObject({
          code: "CANCELLED",
          message: "Cancelled by SIGTERM (exit 143)",
          retryable: false,
          hint: "The run was cancelled; nothing was left behind. Rerun the command.",
        });
        expect(staged()).toEqual([]);
      },
    );

    it.skipIf(process.platform === "win32")(
      "dies by the signal on a second Ctrl-C instead of reporting a clean cancel",
      async () => {
        const out = path.join(tmp, "interrupted-twice");
        const child = execa(
          "node",
          [CLI, "media", "frames", "clip.mp4", "--output-dir", out, "--count", "100", "--json"],
          {
            cwd: tmp,
            env: isolatedEnv(tmp),
            extendEnv: false,
            reject: false,
            timeout: SPAWN_TIMEOUT - 1_000,
          },
        );
        const staged = () =>
          fs.existsSync(out) ? fs.readdirSync(out).filter((n) => n.startsWith(".frames-")) : [];
        const deadline = Date.now() + 10_000;
        while (staged().length === 0 && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 25));
        expect(staged()).toHaveLength(1);
        child.kill("SIGINT");
        // Two pending SIGINTs can merge into one, so let the first be taken before the second.
        await new Promise((r) => setTimeout(r, 2));
        child.kill("SIGINT");
        const res = await child;
        if (res.stdout) {
          // Cleanup won the race: a clean cancel is true only when nothing is left behind.
          expect(envelope(res.stdout).error.code).toBe("CANCELLED");
          expect(staged()).toEqual([]);
        } else {
          // The second signal landed before cleanup finished: the run died by it.
          expect(res.signal).toBe("SIGINT");
        }
      },
    );

    it("prints a readable inspect summary without --json", async () => {
      const res = await run(["media", "inspect", "clip.mp4"]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toMatch(/160x90/);
    });
  });
});
