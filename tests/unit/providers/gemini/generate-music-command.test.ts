/**
 * `gemini generate-music` driven through commander with global fetch stubbed:
 * the Interactions request, saved audio and lyrics, key rotation on 429 only,
 * no re-send on an ambiguous failure, and --interaction-id re-reads.
 * No network or paid calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerGeminiCommands } from "../../../../src/providers/gemini/commands/index.js";
import { _resetGeminiKeyCooldowns } from "../../../../src/providers/gemini/key-pool.js";

const KEY = "music-key-0000";
const KEY2 = "music-key-2222";
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.from([4, 0, 0, 0, 0, 0]), Buffer.alloc(32)]);
const WAV = (() => {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(36 + 8, 4);
  head.write("WAVEfmt ", 8, "latin1");
  head.write("data", 36, "latin1");
  head.writeUInt32LE(8, 40);
  return Buffer.concat([head, Buffer.alloc(8)]);
})();

function interaction(audio: Buffer, mime = "audio/mpeg", text = "[Verse] hello") {
  return {
    id: "v1_song",
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [
          { type: "text", text },
          { type: "audio", mime_type: mime, data: audio.toString("base64") },
        ],
      },
    ],
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

let tmp: string;
let out: string;
let stdout: string[];
let calls: Call[];

function stubFetch(reply: (call: Call) => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    };
    calls.push(call);
    return reply(call);
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function run(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerGeminiCommands(program);
  await program.parseAsync(["node", "multix", "gemini", "generate-music", ...args]);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-lyria-"));
  out = path.join(tmp, "out");
  vi.stubEnv("GEMINI_API_KEY", KEY);
  vi.stubEnv("GEMINI_MUSIC_MODEL", "");
  vi.stubEnv("MULTIX_OUTPUT_DIR", out);
  vi.stubEnv("NO_COLOR", "1");
  _resetOutputDir();
  _resetGeminiKeyCooldowns();
  calls = [];
  stdout = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    stdout.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("gemini generate-music", () => {
  it("posts the prompt to the Interactions API and saves the MP3 and lyrics", async () => {
    stubFetch(() => json(interaction(MP3)));
    const dest = path.join(tmp, "song.mp3");
    await run("--prompt", "Warm lo-fi jazz", "--output", dest);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(call?.method).toBe("POST");
    expect(call?.headers["x-goog-api-key"]).toBe(KEY);
    expect(call?.url).not.toContain(KEY);
    expect(call?.body).toEqual({ model: "lyria-3-clip-preview", input: "Warm lo-fi jazz" });

    const files = fs.readdirSync(out).sort();
    expect(files).toHaveLength(2);
    const audio = files.find((f) => f.endsWith(".mp3")) as string;
    const lyrics = files.find((f) => f.endsWith(".txt")) as string;
    expect(fs.readFileSync(path.join(out, audio))).toEqual(MP3);
    expect(fs.readFileSync(path.join(out, lyrics), "utf8")).toBe("[Verse] hello\n");
    expect(fs.readFileSync(dest)).toEqual(MP3);
    expect(stdout.join("\n")).toContain("Interaction: v1_song");
  });

  it("sends lyrics from a file, images as parts and WAV for lyria-3.5", async () => {
    stubFetch(() => json(interaction(WAV, "audio/wav")));
    const lyricsFile = path.join(tmp, "lyrics.txt");
    fs.writeFileSync(lyricsFile, "﻿[Chorus]\nSing along\n");
    const image = path.join(tmp, "cover.png");
    fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await run(
      "--model",
      "lyria-3.5",
      "--prompt",
      "Melodic indie pop",
      "--lyrics-file",
      lyricsFile,
      "--image",
      image,
      "--output-format",
      "wav",
    );

    expect(calls[0]?.body).toEqual({
      model: "lyria-3.5",
      input: [
        { type: "text", text: "Melodic indie pop\n\nLyrics:\n[Chorus]\nSing along" },
        { type: "image", mime_type: "image/png", data: "iVBORw==" },
      ],
      response_format: { type: "audio", mime_type: "audio/wav" },
    });
    expect(fs.readdirSync(out).some((f) => f.endsWith(".wav"))).toBe(true);
  });

  it("refuses unsupported combinations before any request", async () => {
    stubFetch(() => json({}));
    await expect(run("--prompt", "x", "--output-format", "wav")).rejects.toThrow(/mp3 only/);
    await expect(run("--prompt", "x", "--output-format", "flac")).rejects.toThrow(/mp3 or wav/);
    await expect(run("--prompt", "x", "--lyrics", "a", "--lyrics-file", "b")).rejects.toThrow(
      /not both/,
    );
    await expect(run("--prompt", "x", "--image", "cover.gif")).rejects.toThrow(/JPEG, PNG/);
    await expect(run("--prompt", "x", "--model", "lyria-realtime-exp")).rejects.toThrow(
      /Unsupported music model/,
    );
    await expect(run()).rejects.toThrow(/--prompt is required/);
    await expect(run("--interaction-id", "v1_song", "--prompt", "x")).rejects.toThrow(
      /drop --prompt/,
    );
    expect(calls).toHaveLength(0);
  });

  it("rotates to the next key on 429 only", async () => {
    vi.stubEnv("GEMINI_API_KEY_2", KEY2);
    stubFetch((call) =>
      call.headers["x-goog-api-key"] === KEY
        ? json({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, 429)
        : json(interaction(MP3)),
    );
    await run("--prompt", "x");
    expect(calls.map((c) => c.headers["x-goog-api-key"])).toEqual([KEY, KEY2]);
  });

  it("does not re-send a song after a 500 or a cut-off request", async () => {
    vi.stubEnv("GEMINI_API_KEY_2", KEY2);
    stubFetch(() => json({ error: { message: "internal" } }, 500));
    await expect(run("--prompt", "x")).rejects.toThrow();
    expect(calls).toHaveLength(1);

    calls = [];
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(run("--prompt", "x")).rejects.toThrow(/not retried.*billed/);
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(out) ? fs.readdirSync(out) : []).toEqual([]);
  });

  it("fails on a blocked prompt or bytes that are not audio, saving nothing", async () => {
    stubFetch(() =>
      json({
        status: "completed",
        steps: [{ type: "model_output", content: [{ type: "text", text: "Blocked" }] }],
      }),
    );
    await expect(run("--prompt", "x")).rejects.toThrow("Lyria returned no audio: Blocked");
    stubFetch(() => json(interaction(Buffer.from("not audio at all"), "text/plain")));
    await expect(run("--prompt", "x")).rejects.toThrow(/not a recognised file/);
    expect(fs.existsSync(out) ? fs.readdirSync(out) : []).toEqual([]);
  });

  it("re-reads a stored interaction with --interaction-id instead of generating", async () => {
    stubFetch(() => json(interaction(MP3)));
    await run("--interaction-id", "v1_song");
    expect(calls).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "https://generativelanguage.googleapis.com/v1beta/interactions/v1_song",
      }),
    ]);
    expect(fs.readdirSync(out).some((f) => f.endsWith(".mp3"))).toBe(true);
  });
});
