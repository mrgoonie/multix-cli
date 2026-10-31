/**
 * Lyria music over the Interactions API: request body, response parsing, and
 * the generator end to end with an injected fetch (no network). Covers that
 * an ambiguous failure is never re-sent and that a rate limit rotates keys.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../../../src/agent/run-state.js";
import { ProviderError, ValidationError } from "../../../../src/core/errors.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { readLyricsFile } from "../../../../src/providers/gemini/commands/generate-music.js";
import { generateGeminiMusic } from "../../../../src/providers/gemini/generators/music.js";
import { _resetGeminiKeyCooldowns } from "../../../../src/providers/gemini/key-pool.js";
import {
  buildLyriaInteractionBody,
  parseLyriaInteraction,
  validateLyriaRequest,
} from "../../../../src/providers/gemini/lyria.js";

const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64, 1)]);
const WAV = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVE"),
  Buffer.alloc(64),
]);

function completed(audio: Buffer, text?: string, mime = "audio/mpeg") {
  return {
    id: "v1_abc",
    status: "completed",
    steps: [
      { type: "user_input", content: [{ type: "text", text: "prompt" }] },
      {
        type: "model_output",
        content: [
          ...(text ? [{ type: "text", text }] : []),
          { type: "audio", mime_type: mime, data: audio.toString("base64") },
        ],
      },
    ],
  };
}

describe("buildLyriaInteractionBody", () => {
  it("sends a plain string input and no response_format for the default MP3", () => {
    expect(
      buildLyriaInteractionBody({ model: "lyria-3-clip-preview", prompt: " lo-fi beat " }),
    ).toEqual({ model: "lyria-3-clip-preview", input: "lo-fi beat" });
  });

  it("appends lyrics to the prompt and asks for WAV only when requested", () => {
    const body = buildLyriaInteractionBody({
      model: "lyria-3.5",
      prompt: "pop ballad",
      lyrics: "[Verse]\nhello\n",
      outputFormat: "wav",
    });
    expect(body).toEqual({
      model: "lyria-3.5",
      input: "pop ballad\n\nUse the following lyrics:\n[Verse]\nhello",
      response_format: { type: "audio", mime_type: "audio/wav" },
    });
  });

  it("sends images as content parts after the text", () => {
    const body = buildLyriaInteractionBody({
      model: "lyria-3-clip-preview",
      prompt: "match this mood",
      images: [{ mimeType: "image/png", data: "AAAA" }],
    });
    expect(body.input).toEqual([
      { type: "text", text: "match this mood" },
      { type: "image", mime_type: "image/png", data: "AAAA" },
    ]);
  });

  it("rejects what the model does not take before any request", () => {
    expect(() => validateLyriaRequest({ model: "lyria-2", prompt: "x" })).toThrow(ValidationError);
    expect(() => validateLyriaRequest({ model: "lyria-3.5", prompt: "  " })).toThrow(/--prompt/);
    expect(() =>
      validateLyriaRequest({ model: "lyria-3-clip-preview", prompt: "x", outputFormat: "wav" }),
    ).toThrow(/needs lyria-3.5/);
    expect(() => validateLyriaRequest({ model: "lyria-3.5", prompt: "x", lyrics: " " })).toThrow(
      /--lyrics/,
    );
    const images = Array.from({ length: 11 }, () => ({ mimeType: "image/png", data: "A" }));
    expect(() => validateLyriaRequest({ model: "lyria-3.5", prompt: "x", images })).toThrow(
      /at most 10/,
    );
    expect(() =>
      validateLyriaRequest({
        model: "lyria-3.5",
        prompt: "x",
        images: [{ mimeType: "image/gif", data: "A" }],
      }),
    ).toThrow(/image\/gif/);
  });
});

describe("parseLyriaInteraction", () => {
  it("returns the audio, the id and the lyrics text", () => {
    const r = parseLyriaInteraction(completed(MP3, "[Verse] hello"));
    expect(r).toEqual({
      id: "v1_abc",
      audio: { mimeType: "audio/mpeg", data: MP3.toString("base64") },
      text: "[Verse] hello",
    });
  });

  it("reads the older top-level outputs", () => {
    const r = parseLyriaInteraction({
      status: "completed",
      outputs: [{ type: "audio", mimeType: "audio/wav", data: "UklGRg==" }],
    });
    expect(r.audio).toEqual({ mimeType: "audio/wav", data: "UklGRg==" });
  });

  it("reports a failed status with its error message", () => {
    expect(() =>
      parseLyriaInteraction({ status: "failed", error: { message: "blocked by safety" } }),
    ).toThrow("Lyria interaction failed: blocked by safety");
  });

  it("reports a response without audio with the model's text", () => {
    expect(() =>
      parseLyriaInteraction({
        status: "completed",
        steps: [{ type: "model_output", content: [{ type: "text", text: "I can't do that" }] }],
      }),
    ).toThrow("Lyria returned no audio: I can't do that");
    expect(() => parseLyriaInteraction([])).toThrow(ProviderError);
  });
});

describe("generateGeminiMusic", () => {
  let tmp: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-lyria-"));
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("GEMINI_API_KEY") || k === "MULTIX_OUTPUT_DIR") {
        saved[k] = process.env[k];
        Reflect.deleteProperty(process.env, k);
      }
    }
    process.env.GEMINI_API_KEY = "music-key-0001";
    process.env.MULTIX_OUTPUT_DIR = path.join(tmp, "out");
    _resetOutputDir();
    _resetGeminiKeyCooldowns();
    run.postUsage.length = 0;
  });

  afterEach(() => {
    _resetOutputDir();
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("GEMINI_API_KEY") || k === "MULTIX_OUTPUT_DIR") {
        Reflect.deleteProperty(process.env, k);
      }
    }
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    for (const k of Object.keys(saved)) delete saved[k];
    run.postUsage.length = 0;
  });

  function fetchReturning(...responses: (() => Response)[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      return (next as () => Response)();
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  const json =
    (body: unknown, status = 200) =>
    () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

  it("saves the MP3, the lyrics sidecar and the --output copy, and records one request", async () => {
    const { fn, calls } = fetchReturning(json(completed(MP3, "[Chorus] la la")));
    const output = path.join(tmp, "copies", "song.mp3");
    const result = await generateGeminiMusic({
      model: "lyria-3-clip-preview",
      prompt: "synthwave",
      outputFormat: "mp3",
      output,
      fetch: fn,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(/\/v1beta\/interactions$/);
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("x-goog-api-key")).toBe("music-key-0001");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "lyria-3-clip-preview",
      input: "synthwave",
    });

    expect(result.generatedAudio).toMatch(/gemini_music_.*\.mp3$/);
    expect(fs.readFileSync(result.generatedAudio)).toEqual(MP3);
    expect(fs.readFileSync(result.lyricsFile as string, "utf8")).toBe("[Chorus] la la\n");
    expect(fs.readFileSync(output)).toEqual(MP3);
    expect(result).toMatchObject({ model: "lyria-3-clip-preview", interactionId: "v1_abc" });
    expect(run.postUsage).toEqual([{ tokens: {}, metrics: { "request.count": 1 }, ids: [] }]);
  });

  it("saves under the extension the bytes really have and warns", async () => {
    const { fn } = fetchReturning(json(completed(WAV, undefined, "audio/wav")));
    const warnings: string[] = [];
    const logger = {
      info() {},
      debug() {},
      success() {},
      error() {},
      warn: (m: string) => warnings.push(m),
    };
    const result = await generateGeminiMusic({
      model: "lyria-3.5",
      prompt: "orchestral",
      outputFormat: "mp3",
      fetch: fn,
      logger: logger as never,
    });
    expect(result.generatedAudio).toMatch(/\.wav$/);
    expect(result.lyricsFile).toBeUndefined();
    expect(warnings.join("\n")).toContain("saved as wav");
  });

  it("refuses audio that is neither MP3 nor WAV", async () => {
    const { fn } = fetchReturning(json(completed(Buffer.from("OggS-not-mp3"))));
    await expect(
      generateGeminiMusic({ model: "lyria-3.5", prompt: "x", outputFormat: "mp3", fetch: fn }),
    ).rejects.toThrow(/neither MP3 nor WAV/);
    const out = path.join(tmp, "out");
    expect(fs.existsSync(out) ? fs.readdirSync(out) : []).toEqual([]);
  });

  it("never re-sends the request after a dropped connection", async () => {
    process.env.GEMINI_API_KEY_2 = "music-key-0002";
    const { fn, calls } = fetchReturning(() => {
      throw new TypeError("fetch failed");
    });
    await expect(
      generateGeminiMusic({ model: "lyria-3.5", prompt: "x", outputFormat: "mp3", fetch: fn }),
    ).rejects.toThrow(/not re-sent/);
    expect(calls).toHaveLength(1);
    expect(run.postUsage).toEqual([]);
  });

  it("rotates to the next key on a rate limit, where nothing was generated", async () => {
    process.env.GEMINI_API_KEY_2 = "music-key-0002";
    const { fn, calls } = fetchReturning(
      json({ error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }, 429),
      json(completed(MP3)),
    );
    const result = await generateGeminiMusic({
      model: "lyria-3-clip-preview",
      prompt: "x",
      outputFormat: "mp3",
      fetch: fn,
    });
    expect(calls.map((c) => new Headers(c.init.headers).get("x-goog-api-key"))).toEqual([
      "music-key-0001",
      "music-key-0002",
    ]);
    expect(result.generatedAudio).toMatch(/\.mp3$/);
  });

  it("does not call the API when an image path is missing", async () => {
    const { fn, calls } = fetchReturning(json(completed(MP3)));
    await expect(
      generateGeminiMusic({
        model: "lyria-3.5",
        prompt: "x",
        outputFormat: "mp3",
        imagePaths: [path.join(tmp, "missing.png")],
        fetch: fn,
      }),
    ).rejects.toThrow(/Image not found/);
    expect(calls).toHaveLength(0);
  });
});

describe("readLyricsFile", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-lyrics-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("reads UTF-8 text without a BOM", () => {
    const file = path.join(tmp, "l.txt");
    fs.writeFileSync(file, "﻿[Verse]\nxin chào");
    expect(readLyricsFile(file)).toBe("[Verse]\nxin chào");
  });

  it("rejects a missing, binary or oversized file", () => {
    expect(() => readLyricsFile(path.join(tmp, "nope.txt"))).toThrow(/not found/);
    const bin = path.join(tmp, "b.txt");
    fs.writeFileSync(bin, Buffer.from([0x41, 0x00, 0x42]));
    expect(() => readLyricsFile(bin)).toThrow(/not a text file/);
    const big = path.join(tmp, "big.txt");
    fs.writeFileSync(big, "a".repeat(64 * 1024 + 1));
    expect(() => readLyricsFile(big)).toThrow(/64 KB/);
  });
});
