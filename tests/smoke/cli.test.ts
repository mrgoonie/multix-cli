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
    expect(out).toContain("openai");
    expect(out).toContain("atlas");
    expect(out).toContain("replicate");
  });

  it("lists replicate subcommands", async () => {
    const result = await execa("node", [CLI, "replicate", "--help"], { reject: false });
    expect(result.exitCode).toBe(0);
    const out = result.stdout + result.stderr;
    for (const sub of ["run", "image", "video", "status", "cancel"]) {
      expect(out).toContain(sub);
    }
  });

  it("lists atlas subcommands", async () => {
    const result = await execa("node", [CLI, "atlas", "--help"], { reject: false });
    expect(result.exitCode).toBe(0);
    const out = result.stdout + result.stderr;
    for (const sub of [
      "image",
      "image-to-image",
      "video",
      "image-to-video",
      "audio",
      "3d",
      "run",
      "status",
      "upload",
    ]) {
      expect(out).toContain(sub);
    }
  });

  it("accepts --version as a replicate run option without printing the CLI version", async () => {
    const result = await execa(
      "node",
      [CLI, "replicate", "run", "owner/model", "--version", "abc", "--input", "{}"],
      {
        reject: false,
        env: { REPLICATE_API_TOKEN: "", REPLICATE_API_KEY: "", MULTIX_DISABLE_HOME_ENV: "1" },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("REPLICATE_API_TOKEN is not set");
  });

  it("atlas image without ATLASCLOUD_API_KEY exits non-zero with a setup hint", async () => {
    const result = await execa("node", [CLI, "atlas", "image", "a cat"], {
      reject: false,
      cwd: path.resolve(__dirname, "../.."),
      env: { ATLASCLOUD_API_KEY: "", MULTIX_DISABLE_HOME_ENV: "1" },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ATLASCLOUD_API_KEY");
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
    for (const provider of ["byteplus", "gemini", "openrouter", "leonardo", "minimax", "openai"]) {
      const result = await execa("node", [CLI, provider, "--help"], { reject: false });
      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain("image-to-image");
    }
  }, 15_000);

  it("lists openai subcommands", async () => {
    const result = await execa("node", [CLI, "openai", "--help"], { reject: false });
    expect(result.exitCode).toBe(0);
    const out = result.stdout + result.stderr;
    for (const sub of ["generate", "image-to-image", "generate-speech", "transcribe"]) {
      expect(out).toContain(sub);
    }
  });

  it("rejects openai image-to-image without refs before auth or network work", async () => {
    const result = await execa(
      "node",
      [CLI, "openai", "image-to-image", "--prompt", "test", "--driver", "api"],
      { reject: false },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("At least one --ref is required for image-to-image.");
  });

  it("prints version", async () => {
    const result = await execa("node", [CLI, "--version"], { reject: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});

describe("gemini --files - (smoke)", () => {
  it("reads piped stdin, labels it, and removes the temp file", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-smoke-stdin-"));
    try {
      const result = await execa("node", [CLI, "gemini", "analyze", "--files", "-"], {
        input: "piped notes for analysis",
        cwd: tmp,
        reject: false,
        env: {
          MULTIX_DISABLE_HOME_ENV: "1",
          GEMINI_API_KEY: "",
          TMP: tmp,
          TEMP: tmp,
          TMPDIR: tmp,
        },
      });
      const out = result.stdout + result.stderr;
      // No key is configured, so the request fails after stdin was materialized.
      expect(result.exitCode).toBe(1);
      expect(out).toContain("Failed: <stdin>");
      expect(out).toContain("GEMINI_API_KEY is not set");
      expect(out).not.toContain("piped notes");
      expect(fs.readdirSync(tmp).filter((d) => d.startsWith("multix-stdin-"))).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects an empty pipe", async () => {
    const result = await execa("node", [CLI, "gemini", "transcribe", "--files", "-"], {
      input: "",
      reject: false,
      env: { MULTIX_DISABLE_HOME_ENV: "1" },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("stdin was empty");
  });
});
