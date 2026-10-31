/**
 * Smoke tests — spawn the compiled dist/cli.js and assert expected output.
 * All tests use `node dist/cli.js` to avoid shebang issues on Windows.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Options, execa } from "execa";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "./child-env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../dist/cli.js");
/** Each test spawns `node`; cold starts under a parallel full-suite run can exceed vitest's 5 s default. */
const SPAWN_TIMEOUT = 15_000;

/**
 * Spawn `node dist/cli.js`. The child is killed shortly before the vitest
 * timeout (pass `timeout` to match a longer test), so a hung CLI never
 * outlives the test that started it.
 */
const run = (
  args: string[],
  opts: Pick<Options, "cwd" | "env" | "extendEnv" | "input" | "timeout"> = {},
) => execa("node", [CLI, ...args], { reject: false, timeout: SPAWN_TIMEOUT - 1_000, ...opts });

/** stdin temp dirs the CLI left (or is holding) inside `dir`. */
const stdinDirs = (dir: string) => fs.readdirSync(dir).filter((d) => d.startsWith("multix-stdin-"));

describe("multix --help (smoke)", { timeout: SPAWN_TIMEOUT }, () => {
  it("exits 0 and lists all top-level commands", async () => {
    const result = await run(["--help"]);
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
    expect(out).toContain("runway");
    expect(out).toContain("heygen");
  });

  it("lists heygen subcommands", async () => {
    const result = await run(["heygen", "--help"]);
    expect(result.exitCode).toBe(0);
    const out = result.stdout + result.stderr;
    for (const sub of [
      "video-agent",
      "video",
      "status",
      "avatars",
      "voices",
      "styles",
      "languages",
      "me",
      "translate",
      "lipsync",
      "tts",
      "template",
      "model-video",
      "run",
    ]) {
      expect(out).toContain(sub);
    }
  });

  it("lists replicate subcommands", async () => {
    const result = await run(["replicate", "--help"]);
    expect(result.exitCode).toBe(0);
    const out = result.stdout + result.stderr;
    for (const sub of ["run", "image", "video", "status", "cancel"]) {
      expect(out).toContain(sub);
    }
  });

  it("lists runway subcommands and documents wait/download semantics", async () => {
    const result = await run(["runway", "--help"]);
    expect(result.exitCode).toBe(0);
    const out = result.stdout + result.stderr;
    for (const sub of ["video", "image", "status", "cancel"]) {
      expect(out).toContain(sub);
    }
    const video = await run(["runway", "video", "--help"]);
    const videoOut = video.stdout + video.stderr;
    for (const flag of ["--model", "--image", "--ratio", "--duration", "--wait", "--no-download"]) {
      expect(videoOut).toContain(flag);
    }
  });

  it("fails runway commands without RUNWAYML_API_SECRET with a config error", async () => {
    const result = await run(["runway", "video", "a city"], {
      env: { RUNWAYML_API_SECRET: "", MULTIX_DISABLE_HOME_ENV: "1" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("RUNWAYML_API_SECRET is not set");
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it("lists atlas subcommands", async () => {
    const result = await run(["atlas", "--help"]);
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

  it("fails heygen commands without HEYGEN_API_KEY with a config error, not a stack trace", async () => {
    const result = await run(["heygen", "me"], {
      env: { HEYGEN_API_KEY: "", MULTIX_DISABLE_HOME_ENV: "1" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("HEYGEN_API_KEY is not set");
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it("accepts --version as a replicate run option without printing the CLI version", async () => {
    const result = await run(
      ["replicate", "run", "owner/model", "--version", "abc", "--input", "{}"],
      {
        env: { REPLICATE_API_TOKEN: "", REPLICATE_API_KEY: "", MULTIX_DISABLE_HOME_ENV: "1" },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("REPLICATE_API_TOKEN is not set");
  });

  it("atlas image without ATLASCLOUD_API_KEY exits non-zero with a setup hint", async () => {
    const result = await run(["atlas", "image", "a cat"], {
      cwd: path.resolve(__dirname, "../.."),
      env: { ATLASCLOUD_API_KEY: "", MULTIX_DISABLE_HOME_ENV: "1" },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ATLASCLOUD_API_KEY");
  });

  it("lists elevenlabs subcommands", async () => {
    const result = await run(["elevenlabs", "--help"]);
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
    const result = await run(["gemini", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain("image-to-video");
  });

  it("lists gemini Omni video subcommands", async () => {
    const result = await run(["gemini", "--help"]);
    expect(result.exitCode).toBe(0);
    const out = result.stdout + result.stderr;
    for (const sub of ["edit-video", "extend-video", "video-status", "video-cancel"]) {
      expect(out).toContain(sub);
    }
  });

  it("refuses --aspect-ratio when extending an uploaded video, before any upload", async () => {
    const result = await run([
      "gemini",
      "extend-video",
      "--video",
      "missing.mp4",
      "--aspect-ratio",
      "16:9",
      "--prompt",
      "pan out",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("drop --aspect-ratio");
  });

  it("keeps --aspect-ratio for edit-video --video and refuses an empty follow-up prompt", async () => {
    const edit = await run([
      "gemini",
      "edit-video",
      "--video",
      "missing.mp4",
      "--aspect-ratio",
      "16:9",
      "--prompt",
      "make it night",
    ]);
    expect(edit.exitCode).not.toBe(0);
    expect(edit.stdout + edit.stderr).toContain("Video not found");
    const blank = await run([
      "gemini",
      "extend-video",
      "--interaction-id",
      "v1_x",
      "--prompt",
      " ",
    ]);
    expect(blank.exitCode).not.toBe(0);
    expect(blank.stdout + blank.stderr).toContain("--prompt must not be empty");
  });

  it("documents Omni duration and --no-wait on gemini generate-video", async () => {
    const result = await run(["gemini", "generate-video", "--help"]);
    expect(result.exitCode).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toContain("--duration");
    expect(out).toContain("--no-wait");
  });

  it("lists openrouter video subcommands", async () => {
    const result = await run(["openrouter", "--help"]);
    expect(result.exitCode).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toContain("image-to-video");
    expect(out).toContain("video-status");
    expect(out).toContain("video-models");
  });

  it("lists leonardo subcommands", async () => {
    const result = await run(["leonardo", "--help"]);
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

  it(
    "lists image-to-image subcommand on every provider",
    async () => {
      for (const provider of [
        "byteplus",
        "gemini",
        "openrouter",
        "leonardo",
        "minimax",
        "openai",
      ]) {
        const result = await run([provider, "--help"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toContain("image-to-image");
      }
    },
    6 * SPAWN_TIMEOUT,
  );

  it("lists openai subcommands", async () => {
    const result = await run(["openai", "--help"]);
    expect(result.exitCode).toBe(0);
    const out = result.stdout + result.stderr;
    for (const sub of ["generate", "image-to-image", "generate-speech", "transcribe"]) {
      expect(out).toContain(sub);
    }
  });

  it("rejects openai image-to-image without refs before auth or network work", async () => {
    const result = await run(["openai", "image-to-image", "--prompt", "test", "--driver", "api"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("At least one --ref is required for image-to-image.");
  });

  it("prints version", async () => {
    const result = await run(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});

describe("multix update (smoke)", { timeout: SPAWN_TIMEOUT }, () => {
  // --import takes a URL; a bare Windows path (D:\...) reads as a URL scheme.
  const FAKE_REGISTRY = pathToFileURL(
    path.resolve(__dirname, "fixtures/fake-npm-registry-fetch.mjs"),
  ).href;
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"));

  it("update --check --json reads the installed version from the bundle", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-smoke-update-"));
    try {
      const result = await execa(
        "node",
        ["--import", FAKE_REGISTRY, CLI, "update", "--check", "--json"],
        {
          reject: false,
          cwd: tmp,
          extendEnv: false,
          env: { ...isolatedEnv(tmp), FAKE_REGISTRY_VERSION: "999.0.0" },
          timeout: SPAWN_TIMEOUT - 1_000,
        },
      );
      expect(result.stdout + result.stderr).not.toContain("Cannot find module");
      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout.trim());
      expect(out).toMatchObject({ ok: true, command: "update" });
      expect(JSON.stringify(out)).toContain(`${pkg.version} -> 999.0.0`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("gemini generate (smoke)", { timeout: SPAWN_TIMEOUT }, () => {
  it("refuses Imagen ids before any request, naming the GA default", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-smoke-imagen-"));
    try {
      const result = await run(
        ["gemini", "generate", "--prompt", "a lake", "--model", "imagen-4.0-generate-001"],
        { cwd: tmp, extendEnv: false, env: isolatedEnv(tmp) },
      );
      const out = result.stdout + result.stderr;
      expect(result.exitCode).toBe(1);
      expect(out).toContain("INVALID_INPUT");
      expect(out).toContain("Imagen models are no longer served");
      expect(out).toContain("gemini-3.1-flash-image");
      expect(out).not.toContain("GEMINI_API_KEY is not set");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("gemini --files - (smoke)", { timeout: SPAWN_TIMEOUT }, () => {
  it("reads piped stdin, labels it, and removes the temp file", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-smoke-stdin-"));
    try {
      const result = await run(["gemini", "analyze", "--files", "-"], {
        input: "piped notes for analysis",
        cwd: tmp,
        extendEnv: false,
        env: isolatedEnv(tmp),
      });
      const out = result.stdout + result.stderr;
      // No key is configured, so the request fails after stdin was materialized.
      expect(result.exitCode).toBe(1);
      expect(out).toContain("Failed: <stdin>");
      expect(out).toContain("GEMINI_API_KEY is not set");
      expect(out).not.toContain("piped notes");
      expect(stdinDirs(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects an empty pipe and removes the temp dir it created", async () => {
    // Private temp root: the child's stdin temp dir must not appear in the shared tmpdir.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-smoke-empty-stdin-"));
    try {
      // Keep stdin open until the child has created its temp dir, so the test
      // proves the dir lands in the private root rather than the shared tmpdir.
      const child = run(["gemini", "transcribe", "--files", "-"], {
        cwd: tmp,
        extendEnv: false,
        env: isolatedEnv(tmp),
      });
      const deadline = Date.now() + SPAWN_TIMEOUT / 2;
      while (stdinDirs(tmp).length === 0 && child.exitCode === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const dirsWhileReading = stdinDirs(tmp);
      child.stdin?.end();
      const result = await child;
      expect(dirsWhileReading).toHaveLength(1);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("stdin was empty");
      expect(stdinDirs(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("doc convert --input - (smoke)", { timeout: SPAWN_TIMEOUT }, () => {
  it("reads piped stdin, labels it, and removes the temp file", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-smoke-doc-stdin-"));
    try {
      const result = await run(["doc", "convert", "--input", "-"], {
        input: "piped notes for conversion",
        cwd: tmp,
        extendEnv: false,
        env: isolatedEnv(tmp),
      });
      const out = result.stdout + result.stderr;
      // No key is configured: the run fails on the first attempt, with no retry backoff.
      expect(result.exitCode).toBe(1);
      expect(out).toContain("Failed: <stdin>");
      expect(out).toContain("GEMINI_API_KEY is not set");
      expect(out).not.toContain("piped notes");
      expect(stdinDirs(tmp)).toEqual([]);
      // MULTIX_OUTPUT_DIR is pinned to the test dir, never the user's own.
      expect(fs.existsSync(path.join(tmp, "document-extraction.md"))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("model defaults from a project .env (smoke)", { timeout: SPAWN_TIMEOUT }, () => {
  it("shows the .env model as the --model default", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-smoke-env-model-"));
    try {
      fs.writeFileSync(
        path.join(tmp, ".env"),
        "FAL_IMAGE_MODEL=fal-ai/env-file-model\nBYTEPLUS_VIDEO_MODEL=seedance-2.0-fast\n",
      );
      // Drop shell values so the .env file is the only source.
      const { FAL_IMAGE_MODEL, BYTEPLUS_VIDEO_MODEL, ...env } = isolatedEnv(tmp);
      const opts = { cwd: tmp, extendEnv: false, env };
      const fal = await run(["fal", "image", "--help"], opts);
      expect(fal.exitCode).toBe(0);
      expect(fal.stdout).toContain('(default: "fal-ai/env-file-model")');
      const byteplus = await run(["byteplus", "video", "--help"], opts);
      expect(byteplus.exitCode).toBe(0);
      expect(byteplus.stdout).toContain('(default: "seedance-2.0-fast")');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
