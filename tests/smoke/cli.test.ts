/**
 * Smoke tests — spawn the compiled dist/cli.js and assert expected output.
 * All tests use `node dist/cli.js` to avoid shebang issues on Windows.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../dist/cli.js");

describe("multix --help (smoke)", () => {
  it("exits 0 and lists all top-level commands", async () => {
    const result = await execa("node", [CLI, "--help"], { reject: false });
    expect(result.exitCode).toBe(0);

    const out = result.stdout + result.stderr;
    expect(out).toContain("check");
    expect(out).toContain("gemini");
    expect(out).toContain("minimax");
    expect(out).toContain("openrouter");
    expect(out).toContain("leonardo");
    expect(out).toContain("media");
    expect(out).toContain("doc");
    expect(out).toContain("elevenlabs");
  });

  it("lists elevenlabs subcommands", async () => {
    const result = await execa("node", [CLI, "elevenlabs", "--help"], { reject: false });
    expect(result.exitCode).toBe(0);
    const out = result.stdout + result.stderr;
    for (const sub of [
      "tts",
      "voices",
      "clone",
      "voice-changer",
      "transcribe",
      "sfx",
      "music",
      "dub",
      "dub-status",
      "isolate",
      "align",
      "account",
      "models",
    ]) {
      expect(out).toContain(sub);
    }
  });

  it("lists gemini i2v subcommand", async () => {
    const result = await execa("node", [CLI, "gemini", "--help"], { reject: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain("image-to-video");
  });

  it("lists openrouter video subcommands", async () => {
    const result = await execa("node", [CLI, "openrouter", "--help"], { reject: false });
    expect(result.exitCode).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toContain("image-to-video");
    expect(out).toContain("video-status");
    expect(out).toContain("video-models");
  });

  it("lists leonardo subcommands", async () => {
    const result = await execa("node", [CLI, "leonardo", "--help"], { reject: false });
    expect(result.exitCode).toBe(0);
    const out = result.stdout + result.stderr;
    for (const sub of [
      "generate",
      "video",
      "image-to-video",
      "video-models",
      "upscale",
      "variation",
      "status",
      "models",
      "me",
    ]) {
      expect(out).toContain(sub);
    }
  });

  it("lists image-to-image subcommand on every provider", async () => {
    for (const provider of ["byteplus", "gemini", "openrouter", "leonardo", "minimax"]) {
      const result = await execa("node", [CLI, provider, "--help"], { reject: false });
      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain("image-to-image");
    }
  });

  it("prints version", async () => {
    const result = await execa("node", [CLI, "--version"], { reject: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
