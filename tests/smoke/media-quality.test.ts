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
    });

    it("prints a readable inspect summary without --json", async () => {
      const res = await run(["media", "inspect", "clip.mp4"]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toMatch(/160x90/);
    });
  });
});
