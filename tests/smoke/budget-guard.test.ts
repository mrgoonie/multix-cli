/**
 * Budget smoke tests against dist/cli.js: `--estimate` never sends a request,
 * `--max-cost` fails closed before anything is sent, and a run's receipt
 * reconciles the estimate with what the provider reported. ElevenLabs is
 * answered by a local fetch stub preloaded with `node --import`.
 */

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
