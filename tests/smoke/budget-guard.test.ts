/**
 * Budget smoke tests against dist/cli.js: `--estimate` never sends a request,
 * `--max-cost` fails closed before anything is sent, and a run's receipt
 * reconciles the estimate with what the provider reported. ElevenLabs is
 * answered by a local fetch stub preloaded with `node --import`.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedEnv } from "./child-env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../dist/cli.js");
const FAKE_ELEVENLABS = pathToFileURL(path.join(__dirname, "fixtures/fake-elevenlabs-fetch.mjs"));
const SPAWN_TIMEOUT = 15_000;
const VI = "Xin chào thế giới";
const HAS_FFPROBE = spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

/** A silent 16-bit mono PCM WAV of `seconds` at 8 kHz. */
function silentWav(seconds: number): Buffer {
  const rate = 8000;
  const data = rate * 2 * seconds;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(data, 40);
  return b;
}

describe("budget guards (smoke)", { timeout: SPAWN_TIMEOUT }, () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}, preload?: URL) =>
    execa("node", [...(preload ? ["--import", preload.href] : []), CLI, ...args], {
      reject: false,
      cwd: tmp,
      extendEnv: false,
      env: { ...env, ...extra },
      timeout: SPAWN_TIMEOUT - 1_000,
    });
  const envelope = (stdout: string) => JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
  const ledger = () =>
    fs
      .readFileSync(path.join(tmp, "h.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-smoke-budget-"));
    env = {
      ...isolatedEnv(tmp),
      ELEVENLABS_API_KEY: "test-key-not-real",
      GEMINI_API_KEY: "test-key-not-real",
      OPENROUTER_API_KEY: "test-key-not-real",
      MULTIX_HISTORY: "1",
      MULTIX_HISTORY_FILE: path.join(tmp, "h.jsonl"),
      // Any real request would fail fast instead of hanging.
      HTTPS_PROXY: "http://127.0.0.1:9",
    };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("--estimate prices Vietnamese text in characters and sends nothing", async () => {
    const result = await run(["elevenlabs", "tts", "--text", VI, "--estimate", "--json"]);
    expect(result.exitCode).toBe(0);
    const out = envelope(result.stdout);
    expect(out).toMatchObject({ ok: true, estimate_only: true, outputs: [] });
    expect(out.estimate).toMatchObject({
      status: "estimated",
      upper_bound: "proven",
      text: { characters: 17, utf8_bytes: 22 },
      units: { characters: { low: 17, expected: 17, high: 17 } },
      rate: { id: "elevenlabs/multilingual@api", source: "https://elevenlabs.io/pricing/api" },
    });
    expect(out.cost).toMatchObject({ role: "none", status: "settled", actual_usd: 0 });
    expect(result.stdout).not.toContain("test-key-not-real");
    expect(ledger()[0]).toMatchObject({ estimate_only: true });
  });

  it("--estimate in text mode prints the range, provenance and units", async () => {
    const result = await run(["gemini", "generate-speech", "--text", VI, "--estimate"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gemini-3.8-flash-lite-tts");
    expect(result.stdout).toContain("ai.google.dev/gemini-api/docs/pricing");
    expect(result.stdout).toContain("output_audio_tokens");
    expect(result.stdout).toContain("Nothing was sent; no provider was billed.");
  });

  it("--max-cost refuses an unknown price before any request", async () => {
    const result = await run(
      ["openai", "generate", "--prompt", "a cat", "--max-cost", "1", "--json"],
      {
        OPENAI_API_KEY: "test-key-not-real",
      },
    );
    expect(result.exitCode).toBe(2);
    const out = envelope(result.stdout);
    expect(out.error.code).toBe("BUDGET_UNPROVEN");
    expect(out.estimate).toMatchObject({ status: "unknown", high_usd: null });
    expect(out.next[0]).toContain("--estimate");
    expect(out.next[0]).not.toContain("--max-cost");
  });

  it("--max-cost refuses an estimated ceiling unless --cost-policy estimate", async () => {
    const strict = await run([
      "gemini",
      "generate-speech",
      "--text",
      VI,
      "--max-cost",
      "1",
      "--json",
    ]);
    expect(strict.exitCode).toBe(2);
    expect(envelope(strict.stdout).error.code).toBe("BUDGET_UNPROVEN");
  });

  it("--max-cost refuses a proven ceiling over the limit, and a malformed limit", async () => {
    const over = await run(["elevenlabs", "tts", "--text", VI, "--max-cost", "0.0001", "--json"]);
    expect(over.exitCode).toBe(2);
    const out = envelope(over.stdout);
    expect(out.error.code).toBe("BUDGET_EXCEEDED");
    expect(out.budget).toMatchObject({ max_cost_usd: 0.0001 });
    const bad = await run(["elevenlabs", "tts", "--text", VI, "--max-cost", "abc", "--json"]);
    expect(bad.exitCode).toBe(2);
    expect(envelope(bad.stdout).error.message).toContain("Invalid --max-cost");
  });

  it("a paid run under the limit gets a receipt computed from the billed characters", async () => {
    const result = await run(
      ["elevenlabs", "tts", "--text", VI, "--max-cost", "0.01", "--json"],
      { MULTIX_OPERATION_ID: "job-42" },
      FAKE_ELEVENLABS,
    );
    expect(result.stderr).not.toContain("test-key-not-real");
    expect(result.exitCode).toBe(0);
    const out = envelope(result.stdout);
    expect(out.cost).toMatchObject({
      schema: "multix.cost/v1",
      operation_id: "job-42",
      role: "charge",
      status: "computed",
      actual_source: "computed_from_usage",
      measured: { characters: 17 },
      variance_usd: 0,
      max_cost_usd: 0.01,
    });
    expect(out.cost.actual_usd).toBeCloseTo(0.00136, 9);
    expect(ledger()[0].cost.operation_id).toBe("job-42");
  });

  it("--estimate prices openrouter tts from the OpenRouter catalog and sends nothing", async () => {
    const result = await run([
      "openrouter",
      "tts",
      "--text",
      VI,
      "--model",
      "elevenlabs/eleven-v4",
      "--estimate",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const out = envelope(result.stdout);
    expect(out).toMatchObject({ ok: true, estimate_only: true });
    expect(out.estimate).toMatchObject({
      status: "estimated",
      upper_bound: "proven",
      provider: "openrouter",
      rate: { id: "openrouter/elevenlabs-multilingual@api" },
    });
    expect(result.stdout).not.toContain("test-key-not-real");
  });

  it("--max-cost refuses openrouter transcribe of a URL: its length is not known", async () => {
    const result = await run([
      "openrouter",
      "transcribe",
      "--input",
      "https://example.com/talk.mp3",
      "--max-cost",
      "1",
      "--json",
    ]);
    expect(result.exitCode).toBe(2);
    const out = envelope(result.stdout);
    expect(out.error.code).toBe("BUDGET_UNPROVEN");
    expect(out.estimate).toMatchObject({ status: "unknown", reason: "missing_input" });
  });

  it.skipIf(!HAS_FFPROBE)(
    "--estimate prices openrouter transcribe of a local file by its measured length",
    async () => {
      fs.writeFileSync(path.join(tmp, "talk.wav"), silentWav(2));
      const est = await run([
        "openrouter",
        "transcribe",
        "--input",
        "talk.wav",
        "--model",
        "openai/whisper-1",
        "--estimate",
        "--json",
      ]);
      expect(est.exitCode).toBe(0);
      expect(envelope(est.stdout).estimate).toMatchObject({
        status: "estimated",
        upper_bound: "proven",
        units: { input_audio_seconds: { low: 2, expected: 2, high: 60 } },
        high_usd: 0.006,
      });
      // A ceiling over the limit is refused before the upload.
      const over = await run([
        "openrouter",
        "transcribe",
        "--input",
        "talk.wav",
        "--model",
        "openai/whisper-1",
        "--max-cost",
        "0.001",
        "--json",
      ]);
      expect(over.exitCode).toBe(2);
      expect(envelope(over.stdout).error.code).toBe("BUDGET_EXCEEDED");
    },
  );

  it("speech generate is priced per route, reading --text-file, and sends nothing", async () => {
    fs.writeFileSync(path.join(tmp, "scene.txt"), `${VI}\n`);
    const est = await run([
      "speech",
      "generate",
      "--provider",
      "elevenlabs",
      "--text-file",
      "scene.txt",
      "--estimate",
      "--json",
    ]);
    expect(est.exitCode).toBe(0);
    expect(envelope(est.stdout)).toMatchObject({
      ok: true,
      estimate_only: true,
      estimate: { status: "estimated", upper_bound: "proven", text: { characters: 17 } },
    });
    const over = await run([
      "speech",
      "generate",
      "--provider",
      "elevenlabs",
      "--text",
      VI,
      "--max-cost",
      "0.0001",
      "--json",
    ]);
    expect(over.exitCode).toBe(2);
    expect(envelope(over.stdout).error.code).toBe("BUDGET_EXCEEDED");
  });

  it("speech generate prices the env default Gemini model, as primary and as fallback", async () => {
    const pro = { GEMINI_TTS_MODEL: "gemini-2.5-pro-preview-tts" };
    const primary = await run(
      ["speech", "generate", "--provider", "gemini", "--text", VI, "--estimate", "--json"],
      pro,
    );
    expect(envelope(primary.stdout).estimate).toMatchObject({
      status: "estimated",
      model: "gemini-2.5-pro-preview-tts",
    });
    const fallback = await run(
      [
        "speech",
        "generate",
        "--provider",
        "elevenlabs",
        "--fallback",
        "gemini",
        "--text",
        VI,
        "--estimate",
        "--json",
      ],
      pro,
    );
    expect(envelope(fallback.stdout).estimate.assumptions.join(" ")).toContain(
      "gemini/gemini-2.5-pro-preview-tts",
    );
  });

  it("speech generate with an unpriced --fallback route fails closed", async () => {
    const result = await run(
      [
        "speech",
        "generate",
        "--provider",
        "elevenlabs",
        "--fallback",
        "openai",
        "--text",
        VI,
        "--max-cost",
        "5",
        "--json",
      ],
      { OPENAI_API_KEY: "test-key-not-real" },
    );
    expect(result.exitCode).toBe(2);
    const out = envelope(result.stdout);
    expect(out.error.code).toBe("BUDGET_UNPROVEN");
    expect(out.estimate).toMatchObject({ status: "unknown", reason: "unsupported" });
  });

  it("a submit that fails after it was sent is uncertain, never $0", async () => {
    const result = await run(
      ["elevenlabs", "tts", "--text", VI, "--json"],
      { FAKE_ELEVENLABS_STATUS: "500" },
      FAKE_ELEVENLABS,
    );
    expect(result.exitCode).not.toBe(0);
    const out = envelope(result.stdout);
    expect(out.cost).toMatchObject({ role: "charge", status: "uncertain", actual_usd: null });
  });
});
