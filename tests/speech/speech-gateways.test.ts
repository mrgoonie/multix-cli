/**
 * The gateway routes of `multix speech generate`: OpenRouter (any listed
 * model, checked against the live catalog before the paid request) and fal
 * (verified endpoints on the existing queue and receipts). Run in-process with
 * fetch mocked: the request each route sends, unsupported options, a missing
 * key, a dry run, and the rule that a paid request is sent once and never
 * retried or moved to a fallback. Nothing reaches the network.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/agent/run-state.js";
import { ConfigError, HttpError, ValidationError } from "../../src/core/errors.js";
import { _resetOutputDir } from "../../src/core/output-dir.js";
import {
  type FetchHandler,
  type RecordedCall,
  audioReply,
  jsonReply,
  recordFetch,
  runSpeech,
  setSpeechEnv,
} from "./speech-test-helpers.js";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const OR_KEY = "sk-or-test-not-real-12345";
const FAL_KEY = "fal-test-not-real-12345";
const OR_SPEECH = "https://openrouter.ai/api/v1/audio/speech";
const OR_MODELS = "https://openrouter.ai/api/v1/models?output_modalities=speech";
const FAL_QUEUE = "https://queue.fal.run/";
const FAL_CDN = "https://v3b.fal.media/files/b/out/";
const REQUEST_ID = "0b6c1a2e-1111-2222-3333-444455556666";

const MP3 = Buffer.concat([
  Buffer.from("ID3"),
  Buffer.from([4, 0, 0, 0, 0, 0]),
  Buffer.alloc(32, 2),
]);
const PCM = Buffer.from([0x01, 0x00, 0xfe, 0xff, 0x10, 0x00, 0x20, 0x00]);
const WAV = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from("WAVEfmt "),
  Buffer.alloc(32, 1),
]);

/** The live catalog, trimmed to what the tests use. */
const CATALOG = {
  data: [
    {
      id: "google/gemini-3.8-flash-tts",
      canonical_slug: "google/gemini-3.8-flash-tts-20260922",
      supported_voices: ["Kore", "Puck"],
      architecture: { output_modalities: ["speech"] },
      pricing: { prompt: "0.0000005", completion: "0.000009" },
    },
    {
      id: "elevenlabs/eleven-v4",
      supported_voices: ["george", "sarah"],
      architecture: { output_modalities: ["speech"] },
      pricing: { prompt: "0.00008" },
    },
    {
      id: "hexgrad/kokoro-82m",
      supported_voices: ["af_alloy", "af_bella"],
      architecture: { output_modalities: ["speech"] },
      pricing: { prompt: "0.00000062" },
    },
  ],
};

let tmp: string;
let restoreEnv: (() => void) | undefined;
let restoreFetch: (() => void) | undefined;
let calls: RecordedCall[];

function useEnv(vars: Record<string, string | undefined> = {}): void {
  restoreEnv?.();
  restoreEnv = setSpeechEnv({ MULTIX_OUTPUT_DIR: tmp, ...vars });
  _resetOutputDir();
}

function useFetch(handler: FetchHandler): void {
  restoreFetch?.();
  const mock = recordFetch(handler);
  calls = mock.calls;
  restoreFetch = mock.restore;
}

const posts = (prefix = "") => calls.filter((c) => c.method === "POST" && c.url.startsWith(prefix));

/** OpenRouter: the catalog GET and one speech POST answered with `audio`. */
function openRouter(audio: Response | (() => Response)): void {
  useFetch((call) => {
    if (call.method === "GET" && call.url === OR_MODELS) return jsonReply(CATALOG);
    if (call.method === "POST" && call.url === OR_SPEECH) {
      return typeof audio === "function" ? audio() : audio;
    }
    throw new Error(`unexpected ${call.method} ${call.url}`);
  });
}

/** fal: submit, one COMPLETED status, the result naming `file`, and the CDN download. */
function falQueue(app: string, file: { name: string; bytes: Buffer; type: string }): void {
  const status_url = `${FAL_QUEUE}${app}/requests/${REQUEST_ID}/status`;
  const response_url = `${FAL_QUEUE}${app}/requests/${REQUEST_ID}`;
  useFetch((call) => {
    if (call.method === "POST" && call.url.startsWith(FAL_QUEUE)) {
      return jsonReply({ request_id: REQUEST_ID, status: "IN_QUEUE", status_url, response_url });
    }
    if (call.method === "GET" && call.url === status_url) return jsonReply({ status: "COMPLETED" });
    if (call.method === "GET" && call.url === response_url) {
      return jsonReply({ audio: { url: `${FAL_CDN}${file.name}`, content_type: file.type } });
    }
    if (call.method === "GET" && call.url.startsWith(FAL_CDN)) {
      return new Response(new Uint8Array(file.bytes), {
        status: 200,
        headers: { "content-type": file.type },
      });
    }
    throw new Error(`unexpected ${call.method} ${call.url}`);
  });
}

/**
 * What the agent runtime does on a dry run: report the first request and exit
 * before sending it. Here the fetch mock throws instead, and the client may wrap
 * that error, so the test only asserts that nothing past the first request ran.
 */
async function dryRun(args: string[]): Promise<RecordedCall> {
  useFetch(() => {
    throw new Error("dry run stop");
  });
  run.dryRun = true;
  try {
    await expect(runSpeech(["generate", ...args])).rejects.toThrow();
  } finally {
    run.dryRun = false;
  }
  expect(calls).toHaveLength(1);
  return calls[0] as RecordedCall;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-speech-gateways-"));
  // fal receipts go to ~/.multix/fal/requests: keep them in the sandbox.
  vi.stubEnv("HOME", tmp);
  vi.stubEnv("USERPROFILE", tmp);
  useEnv();
  useFetch(() => {
    throw new Error("unexpected network call");
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  restoreFetch?.();
  restoreEnv?.();
  restoreFetch = undefined;
  restoreEnv = undefined;
  run.dryRun = false;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("openrouter route", () => {
  it("checks the live catalog, posts once and saves the exact bytes with --output", async () => {
    useEnv({ OPENROUTER_API_KEY: OR_KEY });
    openRouter(
      new Response(new Uint8Array(MP3), {
        status: 200,
        headers: { "content-type": "audio/mpeg", "x-generation-id": "gen-123" },
      }),
    );
    const output = path.join(tmp, "nested", "line.mp3");
    const r = await runSpeech([
      "generate",
      "--provider",
      "openrouter",
      "--model",
      "elevenlabs/eleven-v4",
      "--voice",
      "Sarah",
      "--text",
      "Hello there.",
      "--extra",
      "openrouter.speed=1.2",
      "--extra",
      "openrouter.zdr=true",
      "--output",
      output,
    ]);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${OR_MODELS}`,
      `POST ${OR_SPEECH}`,
    ]);
    // The catalog GET is public: the key goes only to the speech request.
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(posts()[0]?.headers.authorization).toBe(`Bearer ${OR_KEY}`);
    expect(posts()[0]?.body).toEqual({
      model: "elevenlabs/eleven-v4",
      input: "Hello there.",
      voice: "sarah", // the catalog spelling
      response_format: "mp3",
      speed: 1.2,
      provider: { zdr: true },
    });
    const data = r.data as { route: Record<string, unknown>; files: string[] };
    expect(r.group).toBe("openrouter");
    expect(data.route).toMatchObject({
      provider: "openrouter",
      model: "elevenlabs/eleven-v4",
      format: "mp3",
    });
    expect(sha256(fs.readFileSync(data.files[0] as string))).toBe(sha256(MP3));
    expect(sha256(fs.readFileSync(output))).toBe(sha256(MP3));
  });

  it("defaults to Gemini 3.8 Flash TTS with voice Kore, sends --style as instructions and wraps pcm in wav", async () => {
    useEnv({ OPENROUTER_API_KEY: OR_KEY });
    openRouter(
      new Response(new Uint8Array(PCM), {
        status: 200,
        headers: { "content-type": "audio/pcm;rate=24000;channels=1" },
      }),
    );
    const r = await runSpeech([
      "generate",
      "--provider",
      "openrouter",
      "--text",
      "Hi.",
      "--style",
      "warm",
    ]);
    expect(posts()[0]?.body).toEqual({
      model: "google/gemini-3.8-flash-tts",
      input: "Hi.",
      voice: "Kore",
      instructions: "warm",
      response_format: "pcm",
    });
    const file = (r.data as { files: string[] }).files[0] as string;
    expect(file.endsWith(".wav")).toBe(true);
    const bytes = fs.readFileSync(file);
    expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
    expect(bytes.subarray(44).equals(PCM)).toBe(true);
  });

  it("accepts a model it has no row for and lets the live catalog check it", async () => {
    useEnv({ OPENROUTER_API_KEY: OR_KEY });
    openRouter(audioReply(MP3));
    await runSpeech([
      "generate",
      "--provider",
      "openrouter",
      "--model",
      "hexgrad/kokoro-82m",
      "--voice",
      "af_bella",
      "--text",
      "Hi.",
    ]);
    expect(posts()[0]?.body).toMatchObject({ model: "hexgrad/kokoro-82m", voice: "af_bella" });
  });

  it("a voice the live catalog does not list fails before the paid request", async () => {
    useEnv({ OPENROUTER_API_KEY: OR_KEY });
    openRouter(audioReply(MP3));
    await expect(
      runSpeech([
        "generate",
        "--provider",
        "openrouter",
        "--model",
        "elevenlabs/eleven-v4",
        "--voice",
        "nobody",
        "--text",
        "Hi.",
      ]),
    ).rejects.toThrow(/Voice "nobody" is not offered by elevenlabs\/eleven-v4/);
    expect(posts()).toHaveLength(0);
  });

  it.each<[string, string[], RegExp]>([
    [
      "--style on ElevenLabs",
      ["--model", "elevenlabs/eleven-v4", "--style", "calm"],
      /takes no delivery style/,
    ],
    ["--emotion", ["--emotion", "happy"], /has no emotion parameter/],
    ["a container Gemini cannot return", ["--format", "mp3"], /writes wav\|pcm, not mp3/],
    ["--async", ["--async"], /drop --async/],
    ["--speaker", ["--speaker", "A:Kore", "--speaker", "B:Puck"], /speaks with one voice/],
    ["an unknown extra", ["--extra", "openrouter.temperature=1"], /not a openrouter option/],
    ["a mistyped extra value", ["--extra", "openrouter.zdr=yes"], /must be true or false/],
  ])("rejects %s before any request", async (_label, extra, message) => {
    useEnv({ OPENROUTER_API_KEY: OR_KEY });
    await expect(
      runSpeech(["generate", "--provider", "openrouter", ...extra, "--text", "Hi."]),
    ).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it("an unlisted model given a format OpenRouter cannot return is refused before any request", async () => {
    useEnv({ OPENROUTER_API_KEY: OR_KEY });
    await expect(
      runSpeech([
        "generate",
        "--provider",
        "openrouter",
        "--model",
        "hexgrad/kokoro-82m",
        "--format",
        "flac",
        "--text",
        "Hi.",
      ]),
    ).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it("without OPENROUTER_API_KEY throws ConfigError and sends nothing", async () => {
    await expect(
      runSpeech(["generate", "--provider", "openrouter", "--text", "Hi."]),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(calls).toHaveLength(0);
  });

  it("a dry run skips the catalog GET and reports the speech request", async () => {
    useEnv({ OPENROUTER_API_KEY: OR_KEY });
    const request = await dryRun(["--provider", "openrouter", "--text", "Hi."]);
    expect(request).toMatchObject({
      method: "POST",
      url: OR_SPEECH,
      body: { model: "google/gemini-3.8-flash-tts", voice: "Kore", response_format: "pcm" },
    });
  });

  it("a 500 is one POST, is not retried and never moves to the fallback", async () => {
    useEnv({ OPENROUTER_API_KEY: OR_KEY, OPENAI_API_KEY: "sk-test-not-real-12345" });
    openRouter(() => jsonReply({ error: { message: "upstream failed" } }, 500));
    await expect(
      runSpeech(["generate", "--provider", "openrouter", "--text", "Hi.", "--fallback", "openai"]),
    ).rejects.toBeInstanceOf(HttpError);
    expect(posts()).toHaveLength(1);
    expect(posts("https://api.openai.com")).toHaveLength(0);
  });
});

describe("fal route", () => {
  it("submits once to the default Gemini endpoint with its field names and saves the wav", async () => {
    useEnv({ FAL_KEY });
    falQueue("google/gemini-3.8-flash-tts", { name: "a.wav", bytes: WAV, type: "audio/wav" });
    const output = path.join(tmp, "line.wav");
    const r = await runSpeech([
      "generate",
      "--provider",
      "fal",
      "--voice",
      "puck",
      "--style",
      "bright",
      "--text",
      "Hello there.",
      "--output",
      output,
    ]);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toMatchObject({
      url: `${FAL_QUEUE}google/gemini-3.8-flash-tts`,
      headers: { authorization: `Key ${FAL_KEY}` },
      body: { prompt: "Hello there.", voice: "Puck", style_instructions: "bright" },
    });
    const data = r.data as { route: Record<string, unknown>; files: string[] };
    expect(r.group).toBe("fal");
    expect(data.route).toMatchObject({ provider: "fal", voice: "Puck", format: "wav" });
    expect(data.files[0]?.endsWith(".wav")).toBe(true);
    expect(sha256(fs.readFileSync(output))).toBe(sha256(WAV));
  });

  it("maps --format pcm and --language to the ElevenLabs endpoint's fields", async () => {
    useEnv({ FAL_KEY });
    falQueue("elevenlabs/tts", { name: "a.pcm", bytes: PCM, type: "audio/pcm" });
    const r = await runSpeech([
      "generate",
      "--provider",
      "fal",
      "--model",
      "elevenlabs/tts/eleven-v4",
      "--format",
      "pcm",
      "--language",
      "vi",
      "--text",
      "Xin chào.",
    ]);
    expect(posts()[0]).toMatchObject({
      url: `${FAL_QUEUE}elevenlabs/tts/eleven-v4`,
      body: { text: "Xin chào.", voice: "Rachel", output_format: "pcm_24000", language_code: "vi" },
    });
    const file = (r.data as { files: string[] }).files[0] as string;
    expect(file.endsWith(".pcm")).toBe(true);
  });

  it("--async returns the request id and the resume command from the saved receipt", async () => {
    useEnv({ FAL_KEY });
    falQueue("elevenlabs/tts", { name: "a.mp3", bytes: MP3, type: "audio/mpeg" });
    const r = await runSpeech([
      "generate",
      "--provider",
      "fal",
      "--model",
      "elevenlabs/tts/eleven-v4-turbo",
      "--async",
      "--text",
      "Hi.",
    ]);
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
    expect(r.data).toMatchObject({
      files: [],
      job: {
        id: REQUEST_ID,
        resume: `multix fal result elevenlabs/tts/eleven-v4-turbo ${REQUEST_ID} --download --format mp3_44100_128`,
      },
    });
    expect(r.stdout).toContain(REQUEST_ID);
    const receipt = path.join(tmp, ".multix", "fal", "requests", `${REQUEST_ID}.json`);
    expect(JSON.parse(fs.readFileSync(receipt, "utf8"))).toMatchObject({ request_id: REQUEST_ID });
  });

  it.each<[string, string[], RegExp]>([
    [
      "a voice outside the Gemini list",
      ["--voice", "Rachel"],
      /"Rachel" is not a voice of fal google\/gemini-3.8-flash-tts/,
    ],
    ["a container Gemini does not write", ["--format", "mp3"], /writes wav, not mp3/],
    [
      "--style on ElevenLabs",
      ["--model", "elevenlabs/tts/eleven-v4", "--style", "calm"],
      /takes no delivery style/,
    ],
    [
      "text over the ElevenLabs limit",
      ["--model", "elevenlabs/tts/eleven-v4", "--text", "x".repeat(5001)],
      /at most 5000 characters/,
    ],
    [
      "a model with no verified schema",
      ["--model", "fal-ai/some-tts"],
      /fal has no speech model "fal-ai\/some-tts"/,
    ],
    ["any extra", ["--extra", "fal.seed=1"], /fal takes no extras/],
  ])("rejects %s before any request", async (_label, extra, message) => {
    useEnv({ FAL_KEY });
    const args = ["generate", "--provider", "fal", ...extra];
    await expect(
      runSpeech(extra.includes("--text") ? args : [...args, "--text", "Hi."]),
    ).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it("without FAL_KEY throws ConfigError and sends nothing", async () => {
    await expect(
      runSpeech(["generate", "--provider", "fal", "--text", "Hi."]),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(calls).toHaveLength(0);
  });

  it("a missing FAL_KEY takes the listed fallback before anything is sent", async () => {
    useEnv({ OPENROUTER_API_KEY: OR_KEY });
    openRouter(audioReply(MP3));
    const r = await runSpeech([
      "generate",
      "--provider",
      "fal",
      "--text",
      "Hi.",
      "--fallback",
      "openrouter:elevenlabs/eleven-v4:george",
    ]);
    expect(posts(FAL_QUEUE)).toHaveLength(0);
    expect(posts(OR_SPEECH)).toHaveLength(1);
    expect(r.data).toMatchObject({
      route: { provider: "openrouter", model: "elevenlabs/eleven-v4", voice: "george" },
      fallback: { from: "fal/google/gemini-3.8-flash-tts" },
    });
  });

  it("a dry run reports the queue submit and sends nothing", async () => {
    useEnv({ FAL_KEY });
    const request = await dryRun(["--provider", "fal", "--text", "Hi."]);
    expect(request).toMatchObject({
      method: "POST",
      url: `${FAL_QUEUE}google/gemini-3.8-flash-tts`,
      body: { prompt: "Hi.", voice: "Kore" },
    });
  });

  it("a gateway 502 on submit is one POST, reported as unknown remote state, never retried", async () => {
    useEnv({ FAL_KEY, OPENROUTER_API_KEY: OR_KEY });
    useFetch((call) => {
      if (call.method === "POST" && call.url.startsWith(FAL_QUEUE)) {
        return new Response("bad gateway", { status: 502 });
      }
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });
    await expect(
      runSpeech(["generate", "--provider", "fal", "--text", "Hi.", "--fallback", "openrouter"]),
    ).rejects.toMatchObject({ code: "UNKNOWN_REMOTE_STATE" });
    expect(posts()).toHaveLength(1);
    expect(posts(OR_SPEECH)).toHaveLength(0);
  });
});

describe("speech models", () => {
  it("lists the gateway rows with their source, verification date and voice listing command", async () => {
    const r = await runSpeech(["models", "--provider", "openrouter"]);
    expect(r.stdout.join("\n")).toContain("multix openrouter speech-models");
    const { speechModels } = await import("../../src/speech/speech-catalog.js");
    const rows = speechModels().filter((m) => m.provider === "openrouter" || m.provider === "fal");
    expect(rows.map((m) => `${m.provider}/${m.model}`)).toEqual([
      "openrouter/google/gemini-3.8-flash-tts",
      "openrouter/google/gemini-3.8-flash-lite-tts",
      "openrouter/elevenlabs/eleven-v4",
      "openrouter/elevenlabs/eleven-v4-turbo",
      "openrouter/fish-audio/drama-3",
      "fal/google/gemini-3.8-flash-tts",
      "fal/google/gemini-3.8-flash-lite-tts",
      "fal/elevenlabs/tts/eleven-v4",
      "fal/elevenlabs/tts/eleven-v4-turbo",
    ]);
    for (const m of rows) {
      expect(m.source).toMatch(/^https:\/\//);
      expect(m.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
