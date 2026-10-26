/**
 * `multix openrouter transcribe` and `transcription-models` driven through
 * commander with global fetch stubbed: the catalog check before the paid
 * POST, multipart upload versus URL input, the saved transcript, the cost
 * lookup, the --json result with nulls for missing metadata, input checks
 * before any request, and that neither the transcript nor the key reaches
 * the logs. No network.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run as runState } from "../../../../src/agent/run-state.js";
import { classifyError } from "../../../../src/core/error-classify.js";
import { HttpError } from "../../../../src/core/errors.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerOpenRouterCommands } from "../../../../src/providers/openrouter/commands/index.js";

const KEY = "sk-or-v1-SECRET_KEY_VALUE";
const TRANSCRIPT = "A private sentence nobody should log.";
const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 1, 2]);

const CATALOG = {
  data: [
    {
      id: "openai/whisper-large-v3-turbo",
      canonical_slug: "openai/whisper-large-v3-turbo",
      name: "OpenAI: Whisper Large V3 Turbo",
      pricing: { prompt: "0.00000333", completion: "0" },
    },
    {
      id: "google/gemini-3.5-transcribe",
      canonical_slug: "google/gemini-3.5-transcribe-20260827",
      pricing: { prompt: "0.000002", completion: "0.000012" },
    },
  ],
};

const GENERATION = {
  data: {
    id: "gen-stt-1-abc",
    model: "openai/whisper-large-v3-turbo",
    provider_name: "Groq",
    total_cost: 0.0000083,
    is_byok: false,
  },
};

const STT = { text: TRANSCRIPT, usage: { seconds: 2.5, cost: 0.000008 } };

interface Call {
  method: string;
  url: string;
  body?: unknown;
  auth?: string | null;
}

let tmp: string;
let audioFile: string;
let output: string[];
let stdout: string[];
let calls: Call[];

function json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

function stubFetch(
  stt: () => Response = () => json(STT, 200, { "x-generation-id": "gen-stt-1-abc" }),
  generation: () => Response = () => json(GENERATION),
) {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body =
      init?.body instanceof FormData
        ? Object.fromEntries(
            [...init.body.entries()].map(([k, v]) => [
              k,
              typeof v === "string" ? v : `<file ${v.name} ${v.type} ${v.size}>`,
            ]),
          )
        : init?.body
          ? JSON.parse(String(init.body))
          : undefined;
    calls.push({
      method,
      url,
      auth: new Headers(init?.headers).get("authorization"),
      ...(body ? { body } : {}),
    });
    if (url.includes("/models?output_modalities=transcription")) return json(CATALOG);
    if (url.includes("/audio/transcriptions")) return stt();
    if (url.includes("/generation?id=")) return generation();
    throw new Error(`unexpected request ${method} ${url}`);
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-openrouter-stt-"));
  audioFile = path.join(tmp, "talk.mp3");
  fs.writeFileSync(audioFile, AUDIO);
  vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(tmp, "out"));
  vi.stubEnv("OPENROUTER_API_KEY", KEY);
  vi.stubEnv("OPENROUTER_STT_MODEL", "");
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

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a failure");
}

const posts = () => calls.filter((c) => c.method === "POST");
const allText = () => output.join("\n");

describe("openrouter transcribe", () => {
  it("checks the catalog, uploads the file once and reports the recorded cost as JSON", async () => {
    stubFetch();
    runState.json = true;
    await run("transcribe", "--input", audioFile, "--language", "en", "-v");

    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
    expect(calls[0]?.auth).toBeNull(); // the public catalog never gets the key
    expect(posts()[0]?.auth).toBe(`Bearer ${KEY}`);
    expect(posts()[0]?.body).toEqual({
      file: `<file audio.mp3 audio/mpeg ${AUDIO.byteLength}>`,
      model: "openai/whisper-large-v3-turbo",
      language: "en",
    });

    const jsonLines = stdout.filter((l) => l.startsWith("{"));
    expect(jsonLines).toHaveLength(1);
    const result = JSON.parse(jsonLines[0] ?? "{}");
    expect(result).toMatchObject({
      model_requested: "openai/whisper-large-v3-turbo",
      model_resolved: "openai/whisper-large-v3-turbo",
      provider: "Groq",
      input: "talk.mp3",
      input_kind: "file",
      input_bytes: AUDIO.byteLength,
      audio_format: "mp3",
      language: "en",
      language_detected: null,
      duration_s: 2.5,
      text: TRANSCRIPT,
      chars: TRANSCRIPT.length,
      generation_id: "gen-stt-1-abc",
      cost_usd: 0.0000083,
      cost_source: "openrouter-generation",
      is_byok: false,
      input_tokens: null,
      output_tokens: null,
      output: null,
    });
    expect(result.input_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(result.path, "utf8")).toBe(TRANSCRIPT);
    expect(path.basename(result.path)).toMatch(/^openrouter_transcript_.+\.txt$/);

    // Neither the transcript nor the key is logged, even with --verbose.
    expect(allText().replace(jsonLines[0] ?? "", "")).not.toContain(TRANSCRIPT);
    expect(allText()).not.toContain(KEY);
  });

  it("passes a URL to the provider, keeps its query out of the result and copies to --output", async () => {
    stubFetch(() => json({ text: TRANSCRIPT, usage: { cost: 0.01 } }));
    runState.json = true;
    const target = path.join(tmp, "copy", "talk.txt");
    await run(
      "transcribe",
      "--input",
      "https://cdn.example.com/a/talk.MP3?X-Amz-Signature=secret",
      "--model",
      "google/gemini-3.5-transcribe-20260827",
      "--output",
      target,
      "--no-cost",
    );

    expect(posts()[0]?.body).toEqual({
      model: "google/gemini-3.5-transcribe", // the catalog id for a dated slug
      input_audio: {
        url: "https://cdn.example.com/a/talk.MP3?X-Amz-Signature=secret",
        format: "mp3",
      },
    });
    expect(calls.some((c) => c.url.includes("/generation"))).toBe(false);
    const result = JSON.parse(stdout[0] ?? "{}");
    expect(result).toMatchObject({
      input: "https://cdn.example.com/a/talk.MP3",
      input_kind: "url",
      input_bytes: null,
      input_sha256: null,
      model_resolved: null,
      generation_id: null,
      duration_s: null,
      cost_usd: 0.01,
      cost_source: "openrouter-usage",
      output: target,
    });
    expect(fs.readFileSync(target, "utf8")).toBe(TRANSCRIPT);
    expect(allText()).not.toContain("X-Amz-Signature");
  });

  it("prints the transcript path, not the transcript, in text mode", async () => {
    stubFetch();
    await run("transcribe", "--input", audioFile, "--cost-wait", "0");
    expect(allText()).toContain("Transcript: ");
    expect(allText()).toContain("$0.000008");
    expect(allText()).not.toContain(TRANSCRIPT);
  });

  it("refuses an unknown model before any paid request", async () => {
    stubFetch();
    const err = await failure(run("transcribe", "--input", audioFile, "--model", "openai/tts-1"));
    expect(err.message).toContain("not an OpenRouter transcription model");
    expect(err.message).toContain("multix openrouter transcription-models");
    expect(posts()).toHaveLength(0);
  });

  it("skips the catalog with --no-model-check and passes OpenRouter's error through", async () => {
    stubFetch(() => json({ error: { message: "Model does not accept URL input" } }, 400));
    const err = await failure(
      run(
        "transcribe",
        "--input",
        "https://cdn.example.com/talk.wav",
        "--model",
        "new/model",
        "--no-model-check",
      ),
    );
    expect(err.message).toContain("Model does not accept URL input");
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });

  it("redacts a signed input URL that OpenRouter echoes in its error", async () => {
    const signed = "https://cdn.example.com/talk.wav?X-Amz-Signature=SECRETSIG";
    stubFetch(() => json({ error: { message: `Failed to download audio from ${signed}` } }, 400));
    const err = await failure(
      run("transcribe", "--input", signed, "--model", "new/model", "--no-model-check"),
    );
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toContain(
      "Failed to download audio from https://cdn.example.com/talk.wav?[redacted]",
    );
    expect(err.message).not.toContain("SECRETSIG");
    expect((err as HttpError).snippet).not.toContain("SECRETSIG");
    const info = classifyError(err);
    expect(info).toMatchObject({ code: "PROVIDER_REJECTED", http_status: 400 });
    expect(info.message).not.toContain("SECRETSIG");
    expect(allText()).not.toContain("SECRETSIG");
  });

  it("fails on an empty transcript without writing a file", async () => {
    stubFetch(() => json({ text: "", usage: {} }, 200, { "x-generation-id": "gen-stt-1-abc" }));
    const err = await failure(run("transcribe", "--input", audioFile));
    expect(err.message).toContain("empty transcript");
    const out = path.join(tmp, "out");
    expect(fs.existsSync(out) ? fs.readdirSync(out) : []).toEqual([]);
  });

  it("validates the input and flags before any request", async () => {
    stubFetch();
    const big = path.join(tmp, "big.wav");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, 25 * 1024 * 1024 + 1);
    const empty = path.join(tmp, "empty.mp3");
    fs.writeFileSync(empty, "");
    const bare = path.join(tmp, "noext");
    fs.writeFileSync(bare, AUDIO);

    const cases: Array<[string[], RegExp]> = [
      [["--input", big], /limited to 25 MB/],
      [["--input", empty], /empty/],
      [["--input", bare], /--audio-format/],
      [["--input", path.join(tmp, "missing.mp3")], /not found/],
      [["--input", "https://cdn.example.com/stream"], /--audio-format/],
      [["--input", "ftp://cdn.example.com/a.mp3"], /not found/],
      [["--input", audioFile, "--audio-format", "../x"], /not valid/],
      [["--input", audioFile, "--language", "english!"], /ISO-639/],
      [["--input", audioFile, "--model", "whisper-1"], /provider\/name/],
      [["--input", audioFile, "--cost-wait", "500"], /cost-wait/],
      [["--input", audioFile, "--timeout", "5"], /--timeout/],
    ];
    for (const [args, message] of cases) {
      expect((await failure(run("transcribe", ...args))).message).toMatch(message);
    }
    expect(calls).toHaveLength(0);
  });

  it("sends --audio-format for a file without an extension", async () => {
    stubFetch();
    const bare = path.join(tmp, "voice-note");
    fs.writeFileSync(bare, AUDIO);
    await run("transcribe", "--input", bare, "--audio-format", "OGG", "--no-cost");
    expect(posts()[0]?.body).toMatchObject({
      file: `<file audio.ogg audio/ogg ${AUDIO.byteLength}>`,
    });
  });
});

describe("openrouter transcription-models", () => {
  it("lists models with their prices, or one as JSON", async () => {
    stubFetch();
    await run("transcription-models");
    expect(allText()).toContain("openai/whisper-large-v3-turbo");
    expect(allText()).toContain("input $0.00000333/unit");
    expect(allText()).toContain("output $0.000012/token");
    expect(calls[0]?.auth).toBeNull();

    stdout = [];
    runState.json = true;
    await run("transcription-models", "--model", "google/gemini-3.5-transcribe");
    expect(JSON.parse(stdout[0] ?? "{}")).toMatchObject({ id: "google/gemini-3.5-transcribe" });

    const err = await failure(run("transcription-models", "--model", "openai/whisper-9"));
    expect(err.message).toContain("not an OpenRouter transcription model");
  });
});
