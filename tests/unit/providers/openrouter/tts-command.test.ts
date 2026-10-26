/**
 * `multix openrouter tts`, `speech-models` and `generation` driven through
 * commander with global fetch stubbed: catalog checks before the paid POST
 * (model, voice, required voice), the request body, mp3/wav output files,
 * the cost lookup, the --json result with nulls for missing metadata, turns
 * files, and that neither the text nor the key reaches the logs. No network.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run as runState } from "../../../../src/agent/run-state.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerOpenRouterCommands } from "../../../../src/providers/openrouter/commands/index.js";
import { parseTurns } from "../../../../src/providers/openrouter/commands/tts.js";

const KEY = "sk-or-v1-SECRET_KEY_VALUE";
const TEXT = "A private sentence nobody should log.";
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 1, 2]);
const PCM = new Uint8Array(4800);

const CATALOG = {
  data: [
    {
      id: "google/gemini-3.8-flash-tts",
      supported_voices: ["Kore", "Puck"],
      pricing: { prompt: "0.0000005", completion: "0.000009" },
    },
    {
      id: "elevenlabs/eleven-v4",
      supported_voices: ["sarah", "george"],
      pricing: { prompt: "0.00008" },
    },
    { id: "fish-audio/drama-3", supported_voices: [], pricing: { prompt: "0.000002" } },
  ],
};

const GENERATION = {
  data: {
    id: "gen-tts-1-abc",
    model: "fish-audio/drama-3-20261013",
    provider_name: "Fish Audio",
    total_cost: 0.000074,
    is_byok: false,
  },
};

interface Call {
  method: string;
  url: string;
  body?: unknown;
  auth?: string | null;
}

let tmp: string;
let output: string[];
let stdout: string[];
let calls: Call[];

function stubFetch(speech: () => Response, generation: () => Response = () => json(GENERATION)) {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const hdrs = new Headers(init?.headers);
    calls.push({
      method,
      url,
      auth: hdrs.get("authorization"),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url.includes("/models?output_modalities=speech")) return json(CATALOG);
    if (url.includes("/audio/speech")) return speech();
    if (url.includes("/generation?id=")) return generation();
    throw new Error(`unexpected request ${method} ${url}`);
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function audio(bytes: Uint8Array, type: string): Response {
  return new Response(bytes, {
    headers: { "content-type": type, "x-generation-id": "gen-tts-1-abc" },
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-openrouter-tts-"));
  vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(tmp, "out"));
  vi.stubEnv("OPENROUTER_API_KEY", KEY);
  vi.stubEnv("OPENROUTER_TTS_MODEL", "");
  vi.stubEnv("MULTIX_MAX_DOWNLOAD_MB", "");
  vi.stubEnv("NO_COLOR", "1");
  _resetOutputDir();
  output = [];
  stdout = [];
  calls = [];
  const capture = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    capture(...args);
    stdout.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(console, "debug").mockImplementation(capture);
});

afterEach(() => {
  runState.json = false;
  runState.dryRun = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: (s) => output.push(s), writeOut: (s) => output.push(s) });
  registerOpenRouterCommands(program);
  await program.parseAsync(["node", "multix", "openrouter", ...args]);
}

const posts = () => calls.filter((c) => c.method === "POST");
const allText = () => output.join("\n");

describe("openrouter tts", () => {
  it("checks the catalog, posts once, saves mp3 and reports the recorded cost as JSON", async () => {
    stubFetch(() => audio(MP3, "audio/mpeg"));
    runState.json = true;
    await run("tts", "--text", TEXT, "--model", "fish-audio/drama-3", "-v");

    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
    expect(calls[0]?.auth).toBeNull(); // the public catalog never gets the key
    expect(posts()[0]?.auth).toBe(`Bearer ${KEY}`);
    expect(posts()[0]?.body).toEqual({
      model: "fish-audio/drama-3",
      input: TEXT,
      response_format: "mp3",
    });

    // --verbose logs go to the console too; the result is the one JSON line.
    const jsonLines = stdout.filter((l) => l.startsWith("{"));
    expect(jsonLines).toHaveLength(1);
    const result = JSON.parse(jsonLines[0] ?? "{}");
    expect(result).toMatchObject({
      model_requested: "fish-audio/drama-3",
      model_resolved: "fish-audio/drama-3-20261013",
      provider: "Fish Audio",
      voice: null,
      input_chars: TEXT.length,
      turns: null,
      format: "mp3",
      mime: "audio/mpeg",
      bytes: MP3.byteLength,
      sample_rate_hz: null,
      duration_s: null,
      generation_id: "gen-tts-1-abc",
      cost_usd: 0.000074,
      cost_source: "openrouter-generation",
      estimated_cost_usd: 0.000074,
      is_byok: false,
      output: null,
    });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(result.path)).toEqual(Buffer.from(MP3));
    expect(path.basename(result.path)).toMatch(/^openrouter_tts_.+\.mp3$/);

    // Neither the text nor the key is logged, even with --verbose.
    expect(allText().replace(jsonLines[0] ?? "", "")).not.toContain(TEXT);
    expect(allText()).not.toContain(KEY);
  });

  it("wraps Gemini pcm in a WAV file at the stated rate and copies it to --output", async () => {
    stubFetch(() => audio(PCM, "audio/pcm;rate=24000;channels=1"));
    runState.json = true;
    const target = path.join(tmp, "copy", "hello.wav");
    await run("tts", "--text", "Hello", "--voice", "kore", "--output", target, "--no-cost");

    expect(posts()[0]?.body).toEqual({
      model: "google/gemini-3.8-flash-tts",
      input: "Hello",
      response_format: "pcm",
      voice: "Kore", // the catalog spelling
    });
    expect(calls.some((c) => c.url.includes("/generation"))).toBe(false);
    const result = JSON.parse(stdout[0] ?? "{}");
    expect(result).toMatchObject({
      format: "wav",
      mime: "audio/wav",
      response_mime: "audio/pcm",
      sample_rate_hz: 24000,
      sample_rate_source: "content-type",
      channels: 1,
      duration_s: 0.1,
      bytes: 44 + PCM.byteLength,
      cost_usd: null,
      cost_source: null,
      estimated_cost_usd: null, // priced per token, so no per-character estimate
      output: target,
    });
    const wav = fs.readFileSync(target);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(24000);
  });

  it("refuses an unknown model before any paid request", async () => {
    stubFetch(() => audio(MP3, "audio/mpeg"));
    await expect(run("tts", "--text", TEXT, "--model", "nope/nope-tts")).rejects.toThrow(
      /model not found/,
    );
    expect(posts()).toHaveLength(0);
  });

  it("refuses an unlisted voice and lists the valid ones", async () => {
    stubFetch(() => audio(MP3, "audio/mpeg"));
    await expect(
      run("tts", "--text", TEXT, "--model", "elevenlabs/eleven-v4", "--voice", "nobody"),
    ).rejects.toThrow(
      /Voice "nobody" is not offered by elevenlabs\/eleven-v4\. Voices: sarah, george/,
    );
    expect(posts()).toHaveLength(0);
  });

  it("requires a voice for ElevenLabs and Gemini", async () => {
    stubFetch(() => audio(MP3, "audio/mpeg"));
    await expect(run("tts", "--text", TEXT, "--model", "elevenlabs/eleven-v4")).rejects.toThrow(
      /needs --voice/,
    );
    await expect(run("tts", "--text", TEXT)).rejects.toThrow(/needs --voice/);
    expect(posts()).toHaveLength(0);
  });

  it("refuses a format the model cannot return", async () => {
    stubFetch(() => audio(MP3, "audio/mpeg"));
    await expect(run("tts", "--text", TEXT, "--voice", "Kore", "--format", "mp3")).rejects.toThrow(
      /pcm only/,
    );
    expect(calls).toHaveLength(0);
  });

  it("skips the catalog with --no-model-check and passes OpenRouter's error through", async () => {
    stubFetch(() =>
      json({ error: { message: "An explicit voice is required for this TTS provider." } }, 400),
    );
    await expect(
      run("tts", "--text", TEXT, "--model", "elevenlabs/eleven-v4", "--no-model-check"),
    ).rejects.toThrow(/explicit voice is required/);
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });

  it("fails on a JSON answer instead of audio without writing a file", async () => {
    stubFetch(() => json({ error: { message: "flagged" } }));
    await expect(run("tts", "--text", TEXT, "--model", "fish-audio/drama-3")).rejects.toThrow(
      /instead of audio/,
    );
    expect(fs.existsSync(path.join(tmp, "out"))).toBe(false);
  });

  it("fails on empty audio", async () => {
    stubFetch(() => audio(new Uint8Array(0), "audio/mpeg"));
    await expect(run("tts", "--text", TEXT, "--model", "fish-audio/drama-3")).rejects.toThrow(
      /0 bytes/,
    );
  });

  it("keeps the audio and a cost hint when the generation is not recorded in time", async () => {
    stubFetch(
      () => audio(MP3, "audio/mpeg"),
      () => json({ error: { message: "Generation not found" } }, 404),
    );
    await run("tts", "--text", TEXT, "--model", "fish-audio/drama-3", "--cost-wait", "0.5");
    expect(allText()).toContain(
      "Cost not reported yet: multix openrouter generation gen-tts-1-abc",
    );
    expect(allText()).toMatch(/Generated audio: .+\.mp3/);
  });

  it("sends turns with voices fixed to the catalog spelling", async () => {
    stubFetch(() => audio(PCM, "audio/pcm"));
    runState.json = true;
    const file = path.join(tmp, "turns.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        { text: "Hi", voice: "kore" },
        { text: "Hello", voice: "PUCK", instructions: "cheerful" },
      ]),
    );
    await run("tts", "--turns-file", file, "--no-cost");
    expect(posts()[0]?.body).toMatchObject({
      input: [
        { text: "Hi", voice: "Kore" },
        { text: "Hello", voice: "Puck", instructions: "cheerful" },
      ],
    });
    const result = JSON.parse(stdout[0] ?? "{}");
    expect(result).toMatchObject({ turns: 2, input_chars: 7, sample_rate_source: "assumed" });
  });

  it("uses the catalog spelling of the model for the format and the request", async () => {
    stubFetch(() => audio(PCM, "audio/pcm;rate=24000;channels=1"));
    runState.json = true;
    await run("tts", "--text", "Hi", "--model", "Google/Gemini-3.8-Flash-TTS", "--voice", "Kore");
    expect(posts()[0]?.body).toMatchObject({
      model: "google/gemini-3.8-flash-tts",
      response_format: "pcm",
    });
    const result = JSON.parse(stdout.find((l) => l.startsWith("{")) ?? "{}");
    expect(result).toMatchObject({ model_requested: "google/gemini-3.8-flash-tts", format: "wav" });
  });

  it("saves MP3 bytes as .mp3 when pcm was asked for, instead of a corrupt WAV", async () => {
    stubFetch(() => audio(MP3, "audio/mpeg"));
    runState.json = true;
    await run(
      "tts",
      "--text",
      "Hi",
      "--model",
      "elevenlabs/eleven-v4",
      "--voice",
      "sarah",
      "--format",
      "wav",
      "--no-cost",
    );
    expect(posts()[0]?.body).toMatchObject({ response_format: "pcm" });
    const result = JSON.parse(stdout.find((l) => l.startsWith("{")) ?? "{}");
    expect(result).toMatchObject({ format: "mp3", mime: "audio/mpeg", sample_rate_hz: null });
    expect(result.path).toMatch(/\.mp3$/);
    expect(fs.readFileSync(result.path)).toEqual(Buffer.from(MP3));
  });

  it("strips a BOM from --text-file", async () => {
    stubFetch(() => audio(MP3, "audio/mpeg"));
    const file = path.join(tmp, "text.txt");
    fs.writeFileSync(file, "\uFEFFHello");
    await run("tts", "--text-file", file, "--model", "fish-audio/drama-3", "--no-cost");
    expect(posts()[0]?.body).toMatchObject({ input: "Hello" });
  });

  it("validates flags before any request", async () => {
    stubFetch(() => audio(MP3, "audio/mpeg"));
    await expect(run("tts")).rejects.toThrow(/Provide the text/);
    await expect(run("tts", "--text", "x", "--model", "gemini")).rejects.toThrow(/provider\/name/);
    await expect(run("tts", "--text", "x", "--prompt", "y")).rejects.toThrow(/only one/);
    await expect(run("tts", "--text", "x", "--speed", "9")).rejects.toThrow(/--speed/);
    await expect(run("tts", "--text", "x", "--cost-wait", "500")).rejects.toThrow(/--cost-wait/);
    await expect(run("tts", "--text", "x", "--provider-options", "[1]")).rejects.toThrow(
      /--provider-options/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("parseTurns", () => {
  it("rejects malformed turns", () => {
    expect(() => parseTurns("not json")).toThrow(/JSON array/);
    expect(() => parseTurns("[]")).toThrow(/1 to 100/);
    expect(() => parseTurns('[{"voice":"Kore"}]')).toThrow(/turn 1 needs/);
    expect(() => parseTurns('[{"text":"a","voice":""}]')).toThrow(/"voice" must be/);
    expect(parseTurns('[{"text":"a","extra":1}]')).toEqual([{ text: "a" }]);
  });
});

describe("openrouter speech-models and generation", () => {
  it("lists models with voice counts and per-character prices", async () => {
    stubFetch(() => audio(MP3, "audio/mpeg"));
    await run("speech-models");
    expect(allText()).toContain("elevenlabs/eleven-v4\t\t2 voices\t$80/1M chars");
    expect(allText()).toContain("fish-audio/drama-3\t\tno listed voices\t$2/1M chars");
    expect(allText()).toContain(
      "google/gemini-3.8-flash-tts\t\t2 voices\t$0.5/1M input tokens + $9/1M audio tokens",
    );
    output = [];
    await run("speech-models", "--model", "google/gemini-3.8-flash-tts");
    expect(allText()).toContain("voices (2): Kore, Puck");
    await expect(run("speech-models", "--model", "nope/x")).rejects.toThrow(/model not found/);
  });

  it("reports a generation's cost as snake_case JSON", async () => {
    stubFetch(() => audio(MP3, "audio/mpeg"));
    runState.json = true;
    await run("generation", "gen-tts-1-abc");
    expect(JSON.parse(stdout[0] ?? "{}")).toEqual({
      generation_id: "gen-tts-1-abc",
      model_resolved: "fish-audio/drama-3-20261013",
      provider: "Fish Audio",
      cost_usd: 0.000074,
      cost_source: "openrouter-generation",
      upstream_cost_usd: null,
      is_byok: false,
      tokens_prompt: null,
      tokens_completion: null,
      latency_ms: null,
    });
    await expect(run("generation", "bad id!")).rejects.toThrow(/Invalid generation id/);
  });

  it("says when a generation is not recorded yet", async () => {
    stubFetch(
      () => audio(MP3, "audio/mpeg"),
      () => json({}, 404),
    );
    await expect(run("generation", "gen-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("not found (yet)"),
    });
  });
});
