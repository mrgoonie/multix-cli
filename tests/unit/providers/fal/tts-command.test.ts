/**
 * `fal tts`, `fal voices` and speech-aware `fal result`, driven through
 * commander with the real env-based client and a scripted fake of fal
 * (global fetch stubbed). Covers two endpoints with different schemas, audio
 * saved under the extension its bytes have (URLs without one, MIME and name
 * disagreeing, raw PCM), blank and non-audio downloads, receipts and resume,
 * and the generic fallback. No network or paid calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellQuote } from "../../../../src/agent/agent-runtime.js";
import { run } from "../../../../src/agent/run-state.js";
import { modelRows } from "../../../../src/commands/agent/models-command.js";
import { MultixError, ProviderError, ValidationError } from "../../../../src/core/errors.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerFalCommands } from "../../../../src/providers/fal/commands/index.js";
import { type FakeReply, KEY, REQUEST_ID, createFakeFal, queueUrls } from "./fake-fal.js";

const GEMINI = "google/gemini-3.8-flash-tts";
const ELEVEN = "elevenlabs/tts/eleven-v4-turbo";
const CDN = "https://v3b.fal.media/files/b/out/";

/** RIFF/WAVE with a 16-byte fmt chunk, then a data chunk of `samples` bytes. */
function wav(samples: number, dataSize = samples): Buffer {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(36 + samples, 4);
  head.write("WAVEfmt ", 8, "latin1");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(24_000, 24);
  head.writeUInt32LE(48_000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "latin1");
  head.writeUInt32LE(dataSize, 40);
  return Buffer.concat([head, Buffer.alloc(samples, 1)]);
}
const WAV = wav(32);
const MP3 = Buffer.concat([
  Buffer.from("ID3"),
  Buffer.from([4, 0, 0, 0, 0, 0]),
  Buffer.alloc(32, 2),
]);
const PCM = Buffer.from([0x01, 0x00, 0xfe, 0xff, 0x10, 0x00, 0x20, 0x00]);

let tmp: string;
let out: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-fal-tts-"));
  out = path.join(tmp, "out");
  vi.stubEnv("HOME", tmp);
  vi.stubEnv("USERPROFILE", tmp);
  vi.stubEnv("FAL_KEY", KEY);
  vi.stubEnv("FAL_BASE_URL", "");
  vi.stubEnv("FAL_TTS_MODEL", "");
  vi.stubEnv("MULTIX_OUTPUT_DIR", out);
  vi.stubEnv("NO_COLOR", "1");
  _resetOutputDir();
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    stdout.push(a.map(String).join(" "));
  });
  for (const m of ["warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      stderr.push(a.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function program(): Command {
  const p = new Command();
  p.exitOverride();
  p.configureOutput({ writeErr: (s) => stderr.push(s), writeOut: (s) => stdout.push(s) });
  registerFalCommands(p);
  return p;
}

async function cli(...args: string[]): Promise<void> {
  await program().parseAsync(["node", "multix", "fal", ...args]);
}

/** Routes for one completed job on `model` whose result is `result` and whose CDN serves `media`. */
function job(model: string, result: unknown, media?: FakeReply) {
  const app = model.split("/").slice(0, 2).join("/");
  const fake = createFakeFal({
    [`POST https://queue.fal.run/${model}`]: [
      { json: { request_id: REQUEST_ID, status: "IN_QUEUE", ...queueUrls(app) } },
    ],
    [`GET https://queue.fal.run/${app}/requests/${REQUEST_ID}/status`]: [
      { json: { status: "COMPLETED" } },
    ],
    [`GET https://queue.fal.run/${app}/requests/${REQUEST_ID}`]: [{ json: result }],
    ...(media ? { [`GET ${CDN}`]: [media] } : {}),
  });
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

function submitted(fake: ReturnType<typeof createFakeFal>) {
  const posts = fake.calls.filter((c) => c.method === "POST");
  expect(posts).toHaveLength(1);
  return JSON.parse(String(posts[0]?.body));
}

const saved = () => fs.readdirSync(out);

describe("fal tts — two endpoints, two schemas", () => {
  it("Gemini: sends prompt/voice/style_instructions and saves the wav", async () => {
    const fake = job(
      GEMINI,
      { audio: { url: `${CDN}x_gemini_tts_output.wav`, content_type: "audio/wav" } },
      { body: WAV, headers: { "content-type": "audio/wav" } },
    );
    await cli("tts", "Xin chào", "--voice", "puck", "--style", "warm", "--wait-timeout", "5000");
    expect(submitted(fake)).toEqual({
      prompt: "Xin chào",
      voice: "Puck",
      style_instructions: "warm",
    });
    expect(saved()).toEqual([`fal-${REQUEST_ID}-01.wav`]);
    expect(stdout.join("\n")).toContain("Generated audio:");
    const cdn = fake.calls.find((c) => c.url.startsWith(CDN));
    expect(cdn?.headers.authorization).toBeUndefined();
  });

  it("ElevenLabs: sends text/output_format and names headerless PCM from the request", async () => {
    const fake = job(
      ELEVEN,
      { audio: { url: `${CDN}blob`, content_type: "application/octet-stream" }, timestamps: null },
      { body: PCM, headers: { "content-type": "application/octet-stream" } },
    );
    await cli("tts", "--text", "Hello", "-m", ELEVEN, "--format", "pcm_16000", "--language", "en");
    expect(submitted(fake)).toEqual({
      text: "Hello",
      output_format: "pcm_16000",
      language_code: "en",
    });
    expect(saved()).toEqual([`fal-${REQUEST_ID}-01.pcm`]);
  });

  it("keeps raw PCM whose first sample looks like an MP3 frame sync", async () => {
    job(
      ELEVEN,
      { audio: { url: `${CDN}output.pcm`, file_name: "output.pcm" } },
      { body: Buffer.from([0xff, 0xff, 0x00, 0x00, 0x01, 0x00]) },
    );
    await cli("tts", "Hi", "-m", ELEVEN, "--format", "pcm_24000");
    expect(saved()).toEqual([`fal-${REQUEST_ID}-01.pcm`]);
  });

  it("keeps raw PCM whose first byte looks like the start of JSON", async () => {
    job(ELEVEN, { audio: { url: `${CDN}blob` } }, { body: Buffer.from([0x7b, 0x01, 0x02, 0x03]) });
    await cli("tts", "Hi", "-m", ELEVEN, "--format", "pcm_16000");
    expect(saved()).toEqual([`fal-${REQUEST_ID}-01.pcm`]);
  });

  it("reads --text-file without its trailing newline", async () => {
    const fake = job(GEMINI, { audio: { url: `${CDN}a.wav` } }, { body: WAV });
    const file = path.join(tmp, "script.txt");
    fs.writeFileSync(file, "﻿Line one.\nLine two.\n");
    await cli("tts", "--text-file", file);
    expect(submitted(fake).prompt).toBe("Line one.\nLine two.");
  });
});

describe("fal tts — audio output verification", () => {
  it("names a URL without an extension by the result's content_type, checked against the bytes", async () => {
    job(GEMINI, { audio: { url: `${CDN}noext`, content_type: "audio/wav" } }, { body: WAV });
    await cli("tts", "Hi");
    expect(saved()).toEqual([`fal-${REQUEST_ID}-01.wav`]);
  });

  it("trusts the bytes over a URL, file name and MIME that disagree", async () => {
    job(
      ELEVEN,
      { audio: { url: `${CDN}out.wav`, content_type: "audio/wav", file_name: "out.wav" } },
      { body: MP3, headers: { "content-type": "audio/wav" } },
    );
    await cli("tts", "Hi", "-m", ELEVEN);
    expect(saved()).toEqual([`fal-${REQUEST_ID}-01.mp3`]);
    expect(stderr.join("\n")).toMatch(/declared wav audio but the bytes are mp3/);
  });

  it("falls back to the response Content-Type when the result names nothing", async () => {
    job(
      GEMINI,
      { audio: `${CDN}stream` },
      { body: MP3, headers: { "content-type": "audio/mpeg" } },
    );
    await cli("tts", "Hi");
    expect(saved()).toEqual([`fal-${REQUEST_ID}-01.mp3`]);
  });

  for (const [name, body, pattern] of [
    ["blank audio", Buffer.alloc(0), /empty audio/],
    ["an HTML error page", Buffer.from("<html><body>Access denied</body></html>"), /not audio/],
    ["bytes that are not the declared container", Buffer.alloc(64, 7), /bytes are not wav/],
    ["a WAV header with no samples", wav(0), /header but no audio samples/],
    ["a streamed WAV header (data size 0) with no samples", wav(0, 0), /no audio samples/],
  ] as const) {
    it(`refuses ${name} and leaves no file behind`, async () => {
      job(GEMINI, { audio: { url: `${CDN}a.wav`, content_type: "audio/wav" } }, { body });
      await expect(cli("tts", "Hi")).rejects.toThrow(pattern);
      expect(fs.existsSync(out) ? saved() : []).toEqual([]);
    });
  }

  it("keeps a streamed WAV whose data size is 0 but whose samples follow", async () => {
    job(GEMINI, { audio: { url: `${CDN}a.wav`, content_type: "audio/wav" } }, { body: wav(8, 0) });
    await cli("tts", "Hi", "--wait-timeout", "5000");
    expect(saved()).toEqual([`fal-${REQUEST_ID}-01.wav`]);
  });

  it("refuses an audio URL that is not https before fetching it", async () => {
    const fake = job(GEMINI, { audio: { url: "http://v3b.fal.media/files/a.wav" } });
    await expect(cli("tts", "Hi")).rejects.toThrow(/only https/);
    expect(fake.calls.some((c) => c.url.includes("fal.media"))).toBe(false);
    expect(fs.existsSync(out) ? saved() : []).toEqual([]);
  });

  it("fails clearly when the result has no audio URL", async () => {
    job(GEMINI, { detail: "nothing" });
    await expect(cli("tts", "Hi")).rejects.toBeInstanceOf(ProviderError);
  });

  it("--no-download prints the result JSON without fetching the audio", async () => {
    const fake = job(GEMINI, { audio: { url: `${CDN}a.wav` } });
    await cli("tts", "Hi", "--no-download");
    expect(JSON.parse(stdout.join("\n")).audio.url).toBe(`${CDN}a.wav`);
    expect(fake.calls.some((c) => c.url.startsWith(CDN))).toBe(false);
  });
});

describe("fal tts — validation before any request", () => {
  const bad: string[][] = [
    ["tts"],
    ["tts", "  "],
    ["tts", "Hi", "--text", "Hi"],
    ["tts", "Hi", "--voice", "Rachel"],
    ["tts", "Hi", "--format", "mp3_44100_128"],
    ["tts", "Hi", "-m", ELEVEN, "--style", "warm"],
    ["tts", "Hi", "-m", ELEVEN, "--format", "flac"],
    ["tts", "Hi", "-m", "fal-ai/other-tts"],
    ["tts", "--text-file", "/no/such/file.txt"],
    ["tts", "Hi", "-m", "not-a-model-id"],
    ["tts", "Hi", "-m", ELEVEN, "--input", '{"output_format":"../../evil"}'],
    ["tts", "-m", ELEVEN, "--input", '{"text":"  "}'],
    ["tts", "--input", '{"turns":[{"speaker_id":"a","text":"Hi"}]}'],
    ["tts", "Hi", "-m", ELEVEN, "--input", '{"language_code":"not a code"}'],
    ["tts", "Hi", "-m", "fal-ai/other-tts", "--text-field", "__proto__"],
    ["tts", "Hi", "-m", "fal-ai/other-tts", "--text-field", "t", "--voice-field", "t"],
  ];
  for (const args of bad) {
    it(`refuses: ${args.join(" ")}`, async () => {
      const fake = job(GEMINI, {});
      await expect(cli(...args)).rejects.toBeInstanceOf(ValidationError);
      expect(fake.calls).toHaveLength(0);
    });
  }
});

describe("fal tts — queue receipts and resume", () => {
  it("--detach saves a receipt; fal result resumes it without submitting again", async () => {
    let fake = job(ELEVEN, {});
    await cli("tts", "Hi", "-m", ELEVEN, "--format", "opus_48000_64", "--detach");
    const receipt = JSON.parse(stdout.join("\n"));
    expect(receipt).toMatchObject({ model: ELEVEN, request_id: REQUEST_ID, status: "IN_QUEUE" });
    expect(fs.existsSync(receipt.receipt_path)).toBe(true);
    expect(fake.calls.map((c) => c.method)).toEqual(["POST"]);

    stdout = [];
    fake = job(
      ELEVEN,
      { audio: { url: `${CDN}output.ogg`, content_type: "audio/ogg" } },
      {
        body: Buffer.concat([Buffer.from("OggS"), Buffer.alloc(32)]),
      },
    );
    await cli("result", receipt.model, receipt.request_id, "--download");
    expect(fake.calls.every((c) => c.method === "GET")).toBe(true);
    expect(saved()).toEqual([`fal-${REQUEST_ID}-01.ogg`]);
  });

  it("a detached raw-format job resumes with --format and is named from it", async () => {
    let fake = job(ELEVEN, {});
    await cli("tts", "Hi", "-m", ELEVEN, "--format", "ulaw_8000", "--detach");
    const receipt = JSON.parse(stdout.join("\n"));
    expect(receipt.result_command).toBe(
      `multix fal result ${ELEVEN} ${REQUEST_ID} --download --format ulaw_8000`,
    );
    // Mu-law silence (0xFF) matches an MP3 frame sync; the requested format wins.
    fake = job(
      ELEVEN,
      { audio: { url: `${CDN}blob` } },
      { body: Buffer.alloc(16, 0xff), headers: { "content-type": "application/octet-stream" } },
    );
    await cli("result", ELEVEN, REQUEST_ID, "--download", "--format", "ulaw_8000");
    expect(fake.calls.every((c) => c.method === "GET")).toBe(true);
    expect(saved()).toEqual([`fal-${REQUEST_ID}-01.ulaw`]);
  });

  it("a raw-format job that fails after the submit resumes with --format and --output-dir", async () => {
    const app = ELEVEN.split("/").slice(0, 2).join("/");
    vi.stubGlobal(
      "fetch",
      createFakeFal({
        [`POST https://queue.fal.run/${ELEVEN}`]: [
          { json: { request_id: REQUEST_ID, status: "IN_QUEUE", ...queueUrls(app) } },
        ],
        [`GET https://queue.fal.run/${app}/requests/${REQUEST_ID}/status`]: [
          { json: { status: "COMPLETED" } },
        ],
        [`GET https://queue.fal.run/${app}/requests/${REQUEST_ID}`]: [
          { status: 401, json: { detail: "unauthorized" } },
        ],
      }).fetch,
    );
    try {
      await expect(
        cli("tts", "Hi", "-m", ELEVEN, "--format", "ulaw_8000", "--output-dir", out),
      ).rejects.toThrow(/Failed to fetch result/);
      expect(run.inFlight).toEqual({
        id: REQUEST_ID,
        resume: `multix fal result ${ELEVEN} ${REQUEST_ID} --download --format ulaw_8000 --output-dir ${shellQuote(out)}`,
      });
    } finally {
      run.inFlight = undefined;
      run.ids = [];
    }
  });

  it("fal result refuses a --format the model does not have", async () => {
    const fake = job(ELEVEN, {});
    for (const args of [
      [ELEVEN, REQUEST_ID, "--download", "--format", "wav"],
      ["fal-ai/flux/schnell", REQUEST_ID, "--download", "--format", "pcm_16000"],
    ]) {
      await expect(cli("result", ...args)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("an ambiguous submit is reported as UNKNOWN_REMOTE_STATE and never retried", async () => {
    const fake = createFakeFal({
      [`POST https://queue.fal.run/${GEMINI}`]: [{ status: 502, json: { detail: "bad gateway" } }],
    });
    vi.stubGlobal("fetch", fake.fetch);
    const err = await cli("tts", "Hi").catch((e) => e);
    expect(err).toBeInstanceOf(MultixError);
    expect((err as MultixError).code).toBe("UNKNOWN_REMOTE_STATE");
    expect(fake.calls).toHaveLength(1);
  });
});

describe("fal tts — generic fallback for unlisted models", () => {
  it("sends only the fields named by --text-field / --voice-field plus --input", async () => {
    const fake = job(
      "fal-ai/other-tts",
      { result: { audio_file: { url: `${CDN}speech.flac` } } },
      { body: Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(16)]) },
    );
    await cli(
      "tts",
      "Hi",
      "-m",
      "fal-ai/other-tts",
      "--text-field",
      "input",
      "--voice-field",
      "speaker",
      "--voice",
      "anna",
      "--input",
      '{"speed":1.2}',
    );
    expect(submitted(fake)).toEqual({ speed: 1.2, input: "Hi", speaker: "anna" });
    expect(saved()).toEqual([`fal-${REQUEST_ID}-01.flac`]);
  });
});

describe("fal run — media URLs without an extension", () => {
  it("names the file by the served Content-Type", async () => {
    job(
      "fal-ai/some-audio",
      { audio: { url: `${CDN}noext` } },
      {
        body: MP3,
        headers: { "content-type": "audio/mpeg" },
      },
    );
    await cli("run", "fal-ai/some-audio", "--input", '{"prompt":"x"}');
    expect(saved()).toEqual([`fal-${REQUEST_ID}-01.mp3`]);
  });
});

describe("discovery", () => {
  it("fal voices <model> prints the typed inputs of that model", async () => {
    await cli("voices", ELEVEN);
    const info = JSON.parse(stdout.join("\n"));
    expect(info.inputs.text).toEqual({ field: "text", required: true, max_chars: 5000 });
    expect(info.inputs.format.values).toContain("pcm_16000");
    expect(info.latency).toBe("low");
  });

  it("fal voices --live lists fal's other TTS endpoints, sending no key", async () => {
    const fake = createFakeFal({
      "GET https://api.fal.ai/v1/models": [
        {
          json: {
            models: [
              { endpoint_id: GEMINI, metadata: {} },
              { endpoint_id: "fal-ai/new-tts", metadata: { display_name: "New" } },
            ],
          },
        },
      ],
    });
    vi.stubGlobal("fetch", fake.fetch);
    await cli("voices", "--live");
    const text = stdout.join("\n");
    expect(text).toContain("fal-ai/new-tts  New");
    expect(text.match(new RegExp(GEMINI, "g"))).toHaveLength(1);
    expect(fake.calls[0]?.headers.authorization).toBeUndefined();
  });

  it("multix models lists fal tts as speech with its models, async and voices lister; fal run stays", () => {
    const p = new Command();
    registerFalCommands(p);
    const rows = modelRows(p);
    expect(rows.find((r) => r.command === "fal tts")).toMatchObject({
      task: "speech",
      default_model: GEMINI,
      models: expect.arrayContaining([GEMINI, ELEVEN, "elevenlabs/tts/eleven-v4"]),
      async: true,
      list: "multix fal voices",
    });
    expect(rows.find((r) => r.command === "fal run")).toMatchObject({ task: "any", async: true });
    expect(rows.find((r) => r.command === "fal image")?.list).toBeUndefined();
  });
});
