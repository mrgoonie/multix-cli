/**
 * `multix speech` against dist/cli.js (run `npm run build` first): model
 * discovery, dry runs that send nothing, and the --json error classes. No key
 * reaches a provider; the dry-run proxy points at a dead port so a request that
 * escaped would fail instead of hanging.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedEnv } from "./child-env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../dist/cli.js");
const SPAWN_TIMEOUT = 15_000;
const DEAD_PROXY = "http://127.0.0.1:9";
/** Every speech key blanked, so the host's own keys never leak into a test. */
const NO_KEYS = {
  GEMINI_API_KEY: "",
  OPENAI_API_KEY: "",
  ELEVENLABS_API_KEY: "",
  MINIMAX_API_KEY: "",
  ATLASCLOUD_API_KEY: "",
  FISH_API_KEY: "",
  OPENROUTER_API_KEY: "",
  FAL_KEY: "",
};

describe("speech (smoke)", { timeout: SPAWN_TIMEOUT }, () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;

  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    execa("node", [CLI, ...args], {
      reject: false,
      cwd: tmp,
      extendEnv: false,
      env: { ...env, ...extra },
      timeout: SPAWN_TIMEOUT - 1_000,
    });

  const envelope = (stdout: string) => {
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0] ?? "{}");
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-smoke-speech-"));
    env = {
      ...isolatedEnv(tmp),
      ...NO_KEYS,
      HTTPS_PROXY: DEAD_PROXY,
      MULTIX_HISTORY: "0",
    };
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  describe("speech models", () => {
    it("lists only models that document the language, with their formats and voice", async () => {
      const result = await run(["speech", "models", "--language", "vi", "--json"]);
      expect(result.exitCode).toBe(0);
      const out = envelope(result.stdout);
      expect(out).toMatchObject({ schema: "multix.result/v1", ok: true, command: "speech models" });

      const rows = out.data as Array<Record<string, unknown>>;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.languages).toContain("vi");
        expect(Array.isArray(row.formats)).toBe(true);
        expect((row.formats as unknown[]).length).toBeGreaterThan(0);
        expect(row.voice).toMatchObject({ kind: expect.stringMatching(/^(names|ids)$/) });
      }
      const models = rows.map((r) => `${r.provider}/${r.model}`);
      expect(models).toContain("openai/tts-1");
      expect(models).toContain("elevenlabs/eleven_v3");
      // Documented as English only, so filtered out for Vietnamese.
      expect(models).not.toContain("elevenlabs/eleven_flash_v2");
    });

    it("reports each provider's key readiness and hides readiness-only rows with --ready", async () => {
      const all = envelope(
        (await run(["speech", "models", "--json"], { OPENAI_API_KEY: "sk-test-not-real-12345" }))
          .stdout,
      );
      const rows = all.data as Array<Record<string, unknown>>;
      expect(rows.find((r) => r.provider === "openai")?.ready).toBe(true);
      expect(rows.find((r) => r.provider === "gemini")?.ready).toBe(false);
      expect(rows.find((r) => r.provider === "gemini")?.keys).toEqual(["GEMINI_API_KEY"]);

      const ready = envelope((await run(["speech", "models", "--ready", "--json"])).stdout);
      expect(ready.data).toEqual([]);
    });

    it("rejects an unknown provider filter with exit 2", async () => {
      const result = await run(["speech", "models", "--provider", "acme", "--json"]);
      expect(result.exitCode).toBe(2);
      expect(envelope(result.stdout).error.code).toBe("INVALID_INPUT");
    });
  });

  describe("speech generate --dry-run", () => {
    it("reports the planned request with a text file and sends nothing", async () => {
      const textFile = path.join(tmp, "scene.txt");
      fs.writeFileSync(textFile, "  Hello from a file.\n");
      const output = path.join(tmp, "scene.mp3");

      const result = await run(
        [
          "speech",
          "generate",
          "--provider",
          "openai",
          "--text-file",
          textFile,
          "--output",
          output,
          "--dry-run",
          "--json",
        ],
        { OPENAI_API_KEY: "sk-test-not-real-12345" },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("sk-test-not-real-12345");
      const out = envelope(result.stdout);
      expect(out).toMatchObject({
        ok: true,
        dry_run: true,
        provider: "openai",
        outputs: [],
        request: {
          method: "POST",
          url: "https://api.openai.com/v1/audio/speech",
          body: {
            model: "gpt-4o-mini-tts",
            input: "Hello from a file.",
            voice: "marin",
            response_format: "mp3",
          },
        },
        data: {
          schema: "multix.speech.result/v1",
          request: { provider: "openai", text_chars: 18, format: "mp3" },
          route: {
            provider: "openai",
            model: "gpt-4o-mini-tts",
            voice: "marin",
            voice_defaulted: true,
          },
        },
      });
      expect(fs.existsSync(output)).toBe(false);
    });

    it("an OpenRouter dry run skips the catalog lookup and reports the speech POST", async () => {
      const result = await run(
        ["speech", "generate", "--provider", "openrouter", "--text", "hi", "--dry-run", "--json"],
        { OPENROUTER_API_KEY: "sk-or-test-not-real-12345" },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("sk-or-test-not-real-12345");
      expect(envelope(result.stdout)).toMatchObject({
        ok: true,
        dry_run: true,
        provider: "openrouter",
        request: {
          method: "POST",
          url: "https://openrouter.ai/api/v1/audio/speech",
          body: { model: "google/gemini-3.8-flash-tts", input: "hi", voice: "Kore" },
        },
      });
    });

    it("a fal dry run reports the queue submit and sends nothing", async () => {
      const result = await run(
        ["speech", "generate", "--provider", "fal", "--text", "hi", "--dry-run", "--json"],
        { FAL_KEY: "fal-test-not-real-12345" },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("fal-test-not-real-12345");
      const out = envelope(result.stdout);
      expect(out).toMatchObject({
        ok: true,
        dry_run: true,
        provider: "fal",
        request: { method: "POST" },
      });
      expect(out.request.url).toMatch(/^https:\/\/queue\.fal\.run\//);
    });

    it("an Atlas dry run without its key stops with MISSING_KEY and no request", async () => {
      const result = await run([
        "speech",
        "generate",
        "--provider",
        "atlas",
        "--text",
        "hi",
        "--dry-run",
        "--json",
      ]);
      expect(result.exitCode).toBe(3);
      expect(envelope(result.stdout).error).toMatchObject({
        code: "MISSING_KEY",
        env: "ATLASCLOUD_API_KEY",
      });
    });
  });

  describe("speech generate validation (--json)", () => {
    it.each<[string, string[], RegExp]>([
      [
        "emotion on openai gpt-4o-mini-tts",
        ["--provider", "openai", "--emotion", "happy"],
        /--style instead/,
      ],
      [
        "Gemini voice on openai",
        ["--provider", "openai", "--voice", "Kore"],
        /"Kore" is not an OpenAI voice/,
      ],
      [
        "OpenAI voice on elevenlabs",
        ["--provider", "elevenlabs", "--voice", "marin"],
        /"marin" is not an ElevenLabs voice id/,
      ],
      [
        "marin on tts-1",
        ["--provider", "openai", "--model", "tts-1", "--voice", "marin"],
        /"marin" is not an OpenAI voice for tts-1/,
      ],
      [
        "language the model does not list",
        ["--provider", "elevenlabs", "--model", "eleven_flash_v2", "--language", "vi"],
        /does not list language "vi"/,
      ],
      ["--async on a non-async model", ["--provider", "openai", "--async"], /drop --async/],
      ["duplicate fallback", ["--provider", "openai", "--fallback", "openai"], /repeats a route/],
      [
        "stray --extra",
        ["--provider", "openai", "--extra", "elevenlabs.stability=0.4"],
        /does not use/,
      ],
      [
        "format mismatched with --output",
        ["--provider", "openai", "--format", "wav", "--output", "clip.mp3"],
        /does not match --output/,
      ],
      ["no provider and no model", [], /Choose a provider/],
    ])("%s exits 2 with INVALID_INPUT", async (_label, extra, message) => {
      const result = await run(["speech", "generate", ...extra, "--text", "hi", "--json"], {
        OPENAI_API_KEY: "sk-test-not-real-12345",
      });
      expect(result.exitCode).toBe(2);
      const out = envelope(result.stdout);
      expect(out).toMatchObject({
        ok: false,
        command: "speech generate",
        error: { code: "INVALID_INPUT" },
      });
      expect(out.error.message).toMatch(message);
      expect(out.error.retryable).toBe(false);
    });

    it("missing text exits 2", async () => {
      const result = await run(["speech", "generate", "--provider", "openai", "--json"], {
        OPENAI_API_KEY: "sk-test-not-real-12345",
      });
      expect(result.exitCode).toBe(2);
      expect(envelope(result.stdout).error.message).toContain("Text is required");
    });

    // A missing input file is classified NOT_FOUND (exit 5) by the generic error
    // classifier, not INVALID_INPUT (exit 2). Asserted as observed; see the report.
    it("a --text-file that does not exist exits 5 with NOT_FOUND", async () => {
      const result = await run(
        [
          "speech",
          "generate",
          "--provider",
          "openai",
          "--text-file",
          path.join(tmp, "nope.txt"),
          "--json",
        ],
        { OPENAI_API_KEY: "sk-test-not-real-12345" },
      );
      expect(result.exitCode).toBe(5);
      const out = envelope(result.stdout);
      expect(out.error.code).toBe("NOT_FOUND");
      expect(out.error.message).toContain("--text-file not found");
    });

    it("a missing key exits 3 with MISSING_KEY and sends nothing", async () => {
      const result = await run([
        "speech",
        "generate",
        "--provider",
        "openai",
        "--text",
        "hi",
        "--json",
      ]);
      expect(result.exitCode).toBe(3);
      const out = envelope(result.stdout);
      expect(out.error).toMatchObject({ code: "MISSING_KEY", env: "OPENAI_API_KEY" });
      expect(out.request).toBeUndefined();
    });
  });
});
