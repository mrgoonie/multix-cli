/**
 * `fal tts` and `fal models` driven through commander against a scripted fake
 * of fal: two TTS endpoints with different schemas (Gemini: prompt + WAV,
 * ElevenLabs: text + output_format + MP3), audio named by its bytes when the
 * URL, file_name or MIME type disagree, blank or non-audio results refused,
 * receipts, one submit only, and validation before any request. No network
 * or paid calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyError } from "../../../../src/core/error-classify.js";
import { ProviderError, ValidationError } from "../../../../src/core/errors.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { FAL_CATALOG_URL } from "../../../../src/providers/fal/catalog.js";
import { registerFalCommands } from "../../../../src/providers/fal/commands/index.js";
import { KEY, REQUEST_ID, createFakeFal } from "./fake-fal.js";

const GEMINI = "google/gemini-3.8-flash-tts";
const ELEVEN = "elevenlabs/tts/eleven-v4";
const CDN = "https://v3.fal.media/files/out/";

/** 44-byte WAV header plus a little PCM. */
const WAV = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x2c, 0, 0, 0]),
  Buffer.from("WAVEfmt "),
  Buffer.alloc(32),
  Buffer.alloc(64, 1),
]);
/** MP3 frame sync + filler. */
const MP3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(256, 7)]);

let tmp: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-fal-tts-"));
  vi.stubEnv("HOME", tmp);
  vi.stubEnv("USERPROFILE", tmp);
  vi.stubEnv("FAL_KEY", KEY);
  vi.stubEnv("FAL_BASE_URL", "");
  vi.stubEnv("FAL_TTS_MODEL", "");
  vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(tmp, "out"));
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

function stub(routes: Parameters<typeof createFakeFal>[0]) {
  const fake = createFakeFal(routes);
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

async function cli(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: (s) => stderr.push(s), writeOut: (s) => stdout.push(s) });
  registerFalCommands(program);
  await program.parseAsync(["node", "multix", "fal", ...args]);
}

function app(model: string): string {
  return model.split("/").slice(0, 2).join("/");
}

/** Submit -> COMPLETED -> result -> CDN bytes for one TTS model. */
function ttsRoutes(
  model: string,
  result: unknown,
  audio: { body: Uint8Array | string; type?: string },
) {
  const base = `https://queue.fal.run/${app(model)}/requests/${REQUEST_ID}`;
  return {
    [`POST https://queue.fal.run/${model}`]: [
      {
        json: {
          request_id: REQUEST_ID,
          status: "IN_QUEUE",
          status_url: `${base}/status`,
          response_url: base,
        },
      },
    ],
    [`GET ${base}/status`]: [{ json: { status: "COMPLETED" } }],
    [`GET ${base}`]: [{ json: result }],
    [`GET ${CDN}`]: [
      {
        status: 200,
        body: audio.body,
        headers: audio.type ? { "content-type": audio.type } : {},
      },
    ],
  };
}

function submitBody(fake: ReturnType<typeof stub>): unknown {
  const posts = fake.calls.filter((c) => c.method === "POST");
  expect(posts).toHaveLength(1);
  return JSON.parse(String(posts[0]?.body));
}

function outFiles(): string[] {
  const dir = path.join(tmp, "out");
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

describe("fal tts: typed endpoints with different schemas", () => {
  it("Gemini (default model): text goes to prompt; an extensionless WAV URL is saved as .wav", async () => {
    const fake = stub(
      ttsRoutes(
        GEMINI,
        { audio: { url: `${CDN}b1c2d3`, content_type: "audio/wav" } },
        { body: WAV, type: "application/octet-stream" },
      ),
    );
    await cli("tts", "Xin chào", "--voice", "puck", "--style", "cheerful");
    expect(submitBody(fake)).toEqual({
      prompt: "Xin chào",
      voice: "Puck",
      style_instructions: "cheerful",
    });
    expect(outFiles()).toEqual([`fal-${REQUEST_ID}-01.wav`]);
    expect(stdout.join("\n")).toMatch(/Saved 1 audio file\(s\)/);
    // The CDN download never carries the key.
    const cdn = fake.calls.find((c) => c.url.startsWith(CDN));
    expect(cdn?.headers.authorization).toBeUndefined();
  });

  it("ElevenLabs: text, output_format and language_code; MP3 bytes win over a .wav name and a text MIME", async () => {
    const fake = stub(
      ttsRoutes(
        ELEVEN,
        { audio: { url: `${CDN}speech.wav`, content_type: "text/plain", file_name: "speech.wav" } },
        { body: MP3, type: "text/plain" },
      ),
    );
    await cli(
      "tts",
      "[excited] Hello",
      "-m",
      ELEVEN,
      "--voice",
      "Aria",
      "--format",
      "mp3_44100_128",
      "--language",
      "en",
    );
    expect(submitBody(fake)).toEqual({
      text: "[excited] Hello",
      voice: "Aria",
      output_format: "mp3_44100_128",
      language_code: "en",
    });
    expect(outFiles()).toEqual([`fal-${REQUEST_ID}-01.mp3`]);
  });

  it("ElevenLabs raw PCM: keeps the declared .pcm name although the bytes have no header", async () => {
    stub(
      ttsRoutes(
        ELEVEN,
        {
          audio: {
            url: `${CDN}output.pcm`,
            content_type: "application/octet-stream",
            file_name: "output.pcm",
          },
        },
        { body: Buffer.alloc(512, 3), type: "application/octet-stream" },
      ),
    );
    await cli("tts", "hi", "-m", ELEVEN, "--format", "pcm_16000");
    expect(outFiles()).toEqual([`fal-${REQUEST_ID}-01.pcm`]);
    expect(stderr.join("\n")).not.toMatch(/Expected pcm/);
  });

  it("reads --text-file (BOM stripped) and accepts Gemini dialogue turns from --input", async () => {
    const fake = stub(ttsRoutes(GEMINI, { audio: { url: `${CDN}a.wav` } }, { body: WAV }));
    const file = path.join(tmp, "script.txt");
    fs.writeFileSync(file, "﻿Line one.\nLine two.");
    await cli("tts", "--text-file", file, "--no-download");
    expect(submitBody(fake)).toEqual({ prompt: "Line one.\nLine two." });
    expect(JSON.parse(stdout.join("\n"))).toEqual({ audio: { url: `${CDN}a.wav` } });

    const fake2 = stub(ttsRoutes(GEMINI, { audio: { url: `${CDN}a.wav` } }, { body: WAV }));
    stdout = [];
    const turns = [{ speaker_id: "A", text: "Hi" }];
    await cli("tts", "--input", JSON.stringify({ turns }), "--no-download");
    expect(submitBody(fake2)).toEqual({ turns });
  });
});

describe("fal tts: bad audio is refused and leaves no file", () => {
  it.each([
    ["blank", ""],
    ["an HTML error page", "<html><body>Access denied</body></html>"],
    ["JSON", '{"error":"expired"}'],
  ])("%s -> ProviderError with a resume hint", async (_label, body) => {
    stub(ttsRoutes(GEMINI, { audio: { url: `${CDN}x.wav` } }, { body, type: "audio/wav" }));
    const err = await cli("tts", "hi").catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(String(err.message)).toContain(`multix fal result ${GEMINI} ${REQUEST_ID} --download`);
    expect(outFiles()).toEqual([]);
  });

  it("a result with no audio URL is a ProviderError naming the request", async () => {
    stub(ttsRoutes(GEMINI, { text: "nothing" }, { body: WAV }));
    await expect(cli("tts", "hi")).rejects.toThrow(/completed without an audio URL/);
  });
});

describe("fal tts: receipts and the single submit", () => {
  it("--detach saves a receipt without the text and returns without polling", async () => {
    const fake = stub(ttsRoutes(ELEVEN, {}, { body: MP3 }));
    await cli("tts", "secret script line", "-m", ELEVEN, "--detach");
    expect(fake.calls.filter((c) => c.method === "GET")).toHaveLength(0);
    const receipt = JSON.parse(stdout.join("\n"));
    expect(receipt).toMatchObject({
      provider: "fal",
      model: ELEVEN,
      request_id: REQUEST_ID,
      result_command: `multix fal result ${ELEVEN} ${REQUEST_ID} --download`,
    });
    const saved = fs.readFileSync(receipt.receipt_path, "utf8");
    expect(saved).not.toContain("secret script line");
    expect(saved).not.toContain(KEY);
  });

  it("a submit cut off before fal answered is UNKNOWN_REMOTE_STATE and is not retried", async () => {
    const fake = stub({
      [`POST https://queue.fal.run/${GEMINI}`]: [{ error: new TypeError("fetch failed") }],
    });
    const err = await cli("tts", "hi").catch((e) => e);
    const info = classifyError(err);
    expect(info.code).toBe("UNKNOWN_REMOTE_STATE");
    expect(info.retryable).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("fal tts: validation happens before any request", () => {
  it.each([
    [["tts"]],
    [["tts", "   "]],
    [["tts", "hi", "--format", "mp3_44100_128"]],
    [["tts", "hi", "--voice", "Rachel"]],
    [["tts", "hi", "-m", ELEVEN, "--style", "calm"]],
    [["tts", "a".repeat(5001), "-m", ELEVEN]],
    [["tts", "hi", "--text-file", "missing.txt"]],
    [["tts", "hi", "--input", '{"prompt":"other"}']],
    [["tts", "hi", "-m", "not-a-model"]],
  ])("%j", async (args) => {
    const fake = stub({});
    await expect(cli(...args)).rejects.toBeInstanceOf(ValidationError);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses the text both as argument and --text-file, and an empty file", async () => {
    const fake = stub({});
    const file = path.join(tmp, "t.txt");
    fs.writeFileSync(file, "hi");
    await expect(cli("tts", "hi", "--text-file", file)).rejects.toThrow(/not both/);
    fs.writeFileSync(file, " \n");
    await expect(cli("tts", "--text-file", file)).rejects.toThrow(/is empty/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("fal tts: untyped endpoints (generic fallback)", () => {
  it("warns, sends the text to --text-field and downloads whatever audio comes back", async () => {
    const model = "fal-ai/kokoro/american-english";
    const fake = stub(
      ttsRoutes(model, { speech: [{ url: `${CDN}k` }] }, { body: WAV, type: "audio/wav" }),
    );
    await cli("tts", "hello", "-m", model, "--text-field", "prompt", "--voice", "af_heart");
    expect(submitBody(fake)).toEqual({ prompt: "hello", voice: "af_heart" });
    expect(stderr.join("\n")).toMatch(/has no typed profile/);
    expect(outFiles()).toEqual([`fal-${REQUEST_ID}-01.wav`]);
  });

  it("honours FAL_TTS_MODEL as the default model", async () => {
    vi.stubEnv("FAL_TTS_MODEL", ELEVEN);
    const fake = stub(ttsRoutes(ELEVEN, {}, { body: MP3 }));
    await cli("tts", "hi", "--detach");
    expect(fake.calls[0]?.url).toBe(`https://queue.fal.run/${ELEVEN}`);
    expect(submitBody(fake)).toEqual({ text: "hi" });
  });
});

describe("fal models", () => {
  it("--typed --json lists the typed TTS profiles offline", async () => {
    const fake = stub({});
    await cli("models", "--typed", "--json");
    const rows = JSON.parse(stdout.join("\n"));
    expect(rows.map((r: { endpoint_id: string }) => r.endpoint_id)).toEqual([
      GEMINI,
      "google/gemini-3.8-flash-lite-tts",
      ELEVEN,
      "elevenlabs/tts/eleven-v4-turbo",
    ]);
    expect(rows[0]).toMatchObject({ text_field: "prompt", output: "wav", async: true });
    expect(rows[2]).toMatchObject({
      text_field: "text",
      max_chars: 5000,
      formats: { default: "mp3_44100_128" },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("reads the live catalog page by page, keyless, and marks typed endpoints", async () => {
    const fake = stub({
      [`GET ${FAL_CATALOG_URL}`]: [
        {
          json: {
            models: [
              { endpoint_id: GEMINI, metadata: { display_name: "Gemini TTS", status: "active" } },
            ],
            has_more: true,
            next_cursor: "c2",
          },
        },
        {
          json: {
            models: [{ endpoint_id: "fal-ai/kokoro", metadata: { status: "active" } }],
            has_more: false,
          },
        },
      ],
    });
    await cli("models", "--category", "text-to-speech", "--json");
    expect(JSON.parse(stdout.join("\n"))).toEqual([
      { endpoint_id: GEMINI, display_name: "Gemini TTS", status: "active", typed: true },
      { endpoint_id: "fal-ai/kokoro", status: "active" },
    ]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.url).toContain("category=text-to-speech");
    expect(fake.calls[1]?.url).toContain("cursor=c2");
    for (const c of fake.calls) expect(c.headers.authorization).toBeUndefined();
  });

  it("rejects a bad --limit before any request", async () => {
    const fake = stub({});
    await expect(cli("models", "--limit", "0")).rejects.toBeInstanceOf(ValidationError);
    expect(fake.calls).toHaveLength(0);
  });
});
