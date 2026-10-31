import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../../../src/agent/run-state.js";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import { ProviderError, ValidationError } from "../../../../src/core/errors.js";
import type { Logger } from "../../../../src/core/logger.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { _resetGeminiKeyCooldowns } from "../../../../src/providers/gemini/key-pool.js";
import {
  type LyriaRunOptions,
  readLyriaImages,
  readLyricsFile,
  runLyriaMusic,
} from "../../../../src/providers/gemini/lyria-flow.js";

const API = "https://generativelanguage.googleapis.com/v1beta";
const KEY1 = "test-key-1";
const KEY2 = "test-key-2";
const ID = "v1_song123";
const MP3 = Buffer.from("ID3\u0003\u0000\u0000fake-mp3-bytes");
const WAV = Buffer.concat([Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVEfmt "), Buffer.alloc(16)]);

interface Call {
  method: string;
  url: string;
  key?: string;
  body?: Record<string, unknown>;
}

let tmp: string;
let outDir: string;
let calls: Call[];
const savedEnv: Record<string, string | undefined> = {};

const logger: Logger = {
  info() {},
  success() {},
  warn() {},
  error() {},
  debug() {},
  header() {},
};

function stubFetch(route: (call: Call) => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url,
      key: new Headers(init.headers ?? {}).get("x-goog-api-key") ?? undefined,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return route(call);
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const isSubmit = (c: Call) => c.method === "POST" && c.url === `${API}/interactions`;
const isPoll = (c: Call) => c.method === "GET" && c.url === `${API}/interactions/${ID}`;
const accepted = (model = "lyria-3-clip-preview") => json({ id: ID, status: "in_progress", model });

function completed(audio: Buffer = MP3, text?: string, model = "lyria-3-clip-preview") {
  return {
    id: ID,
    status: "completed",
    model,
    steps: [
      { type: "user_input", content: [{ type: "text", text: "prompt" }] },
      {
        type: "model_output",
        content: [
          ...(text ? [{ type: "text", text }] : []),
          { type: "audio", data: audio.toString("base64") },
        ],
      },
    ],
  };
}

function runOpts(over: Partial<LyriaRunOptions> = {}): LyriaRunOptions {
  return {
    request: { model: "lyria-3-clip-preview", prompt: "lo-fi piano" },
    wait: true,
    waitTimeoutMs: 60_000,
    logger,
    ...over,
  };
}

async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  const deadline = performance.now() + 4_000;
  while (!done) {
    if (performance.now() > deadline) throw new Error("flow did not settle");
    await vi.advanceTimersByTimeAsync(1_000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return p;
}

function readRecord(): Record<string, unknown> {
  const file = fs.readdirSync(outDir).find((f) => f.endsWith(".json"));
  if (!file) throw new Error("no session record written");
  return JSON.parse(fs.readFileSync(path.join(outDir, file), "utf8"));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-lyria-flow-"));
  outDir = path.join(tmp, "out");
  calls = [];
  run.postUsage = [];
  run.inFlight = undefined;
  _resetGeminiKeyCooldowns();
  _resetOutputDir();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GEMINI_API_KEY") || k === "MULTIX_OUTPUT_DIR") {
      savedEnv[k] = process.env[k];
      Reflect.deleteProperty(process.env, k);
    }
  }
  process.env.GEMINI_API_KEY = KEY1;
  process.env.MULTIX_OUTPUT_DIR = outDir;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GEMINI_API_KEY") || k === "MULTIX_OUTPUT_DIR") {
      Reflect.deleteProperty(process.env, k);
    }
  }
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("runLyriaMusic", () => {
  it("submits once, polls on the same key, saves the MP3 and settles one request", async () => {
    stubFetch((c) => (isSubmit(c) ? accepted() : json(completed())));
    const result = await settle(runLyriaMusic(runOpts()));

    expect(calls.filter(isSubmit)).toHaveLength(1);
    expect(calls.filter(isSubmit)[0]?.body).toEqual({
      model: "lyria-3-clip-preview",
      input: "lo-fi piano",
      store: true,
      background: true,
    });
    expect(calls.filter(isPoll).every((c) => c.key === KEY1)).toBe(true);
    expect(result.interactionId).toBe(ID);
    expect(result.dest).toMatch(/gemini_lyria_.*\.mp3$/);
    expect(fs.readFileSync(result.dest ?? "")).toEqual(MP3);
    expect(result.lyricsPath).toBeUndefined();
    expect(run.postUsage).toEqual([{ tokens: {}, metrics: { "request.count": 1 }, ids: [] }]);
    expect(run.inFlight).toEqual({ id: ID, resume: `multix gemini music-status ${ID} --download` });

    const record = readRecord();
    expect(record).toMatchObject({
      interaction_id: ID,
      model: "lyria-3-clip-preview",
      key_alias: "GEMINI_API_KEY",
      status: "completed",
      output_path: result.dest,
      cost_estimate: { usd: 0.04 },
    });
    expect(JSON.stringify(record)).not.toContain(KEY1);
  });

  it("names the file by the bytes returned and saves lyrics, copying to --output", async () => {
    const output = path.join(tmp, "copy", "song.wav");
    stubFetch((c) =>
      isSubmit(c)
        ? accepted("lyria-3.5")
        : json(completed(WAV, "[Verse] rain on the window", "lyria-3.5")),
    );
    const result = await settle(
      runLyriaMusic(
        runOpts({
          request: { model: "lyria-3.5", prompt: "indie", lyrics: "rain", format: "wav" },
          output,
        }),
      ),
    );
    expect(result.dest).toMatch(/\.wav$/);
    expect(fs.readFileSync(output)).toEqual(WAV);
    expect(fs.readFileSync(result.lyricsPath ?? "", "utf8")).toBe("[Verse] rain on the window\n");
    expect(calls.filter(isSubmit)[0]?.body?.response_format).toEqual({
      type: "audio",
      mime_type: "audio/wav",
    });
  });

  it("rotates to the next key only on a quota response", async () => {
    process.env.GEMINI_API_KEY_2 = KEY2;
    stubFetch((c) => {
      if (isSubmit(c) && c.key === KEY1) {
        return json({ error: { code: 429, message: "quota exceeded" } }, 429);
      }
      return isSubmit(c) ? accepted() : json(completed());
    });
    await settle(runLyriaMusic(runOpts()));
    expect(calls.filter(isSubmit).map((c) => c.key)).toEqual([KEY1, KEY2]);
    expect(calls.filter(isPoll).every((c) => c.key === KEY2)).toBe(true);
  });

  it("never resubmits after a lost response or a 5xx, and says it may be billed", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(settle(runLyriaMusic(runOpts()))).rejects.toThrow(/not retried.*billed/);
    expect(calls.filter(isSubmit)).toHaveLength(1);

    calls = [];
    stubFetch(() => json({ error: { code: 500, message: "internal" } }, 500));
    await expect(settle(runLyriaMusic(runOpts()))).rejects.toThrow(/may already be generating/);
    expect(calls.filter(isSubmit)).toHaveLength(1);
    expect(run.postUsage).toEqual([]);
  });

  it("keeps the id and points at music-status when polling times out", async () => {
    stubFetch((c) => (isSubmit(c) ? accepted() : json({ id: ID, status: "in_progress" })));
    const error = await settle(runLyriaMusic(runOpts({ waitTimeoutMs: 20_000 }))).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PollTimeoutError);
    expect(String((error as Error).message)).toContain(`multix gemini music-status ${ID}`);
    expect(readRecord()).toMatchObject({ interaction_id: ID, status: "in_progress" });
    expect(run.postUsage).toEqual([]);
  });

  it("returns the id without polling under --no-wait", async () => {
    stubFetch(() => accepted());
    const result = await settle(runLyriaMusic(runOpts({ wait: false })));
    expect(result).toMatchObject({ interactionId: ID });
    expect(result.dest).toBeUndefined();
    expect(calls.filter(isPoll)).toHaveLength(0);
  });

  it("fails without saving when the song failed or is not audio", async () => {
    stubFetch((c) =>
      isSubmit(c)
        ? accepted()
        : json({ id: ID, status: "failed", error: { message: "blocked by safety" } }),
    );
    await expect(settle(runLyriaMusic(runOpts()))).rejects.toThrow(/failed: blocked by safety/);
    expect(readRecord()).toMatchObject({ status: "failed" });

    stubFetch((c) => (isSubmit(c) ? accepted() : json(completed(Buffer.from("<html>")))));
    await expect(settle(runLyriaMusic(runOpts()))).rejects.toThrow(ProviderError);
    expect(fs.readdirSync(outDir).filter((f) => /\.(mp3|wav)$/.test(f))).toEqual([]);
  });

  it("refuses unsupported options before any request", async () => {
    stubFetch(() => accepted());
    await expect(
      runLyriaMusic(
        runOpts({ request: { model: "lyria-3-clip-preview", prompt: "x", format: "wav" } }),
      ),
    ).rejects.toThrow(ValidationError);
    await expect(runLyriaMusic(runOpts({ imagePaths: [path.join(tmp, "a.png")] }))).rejects.toThrow(
      /does not take reference images/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("local inputs", () => {
  it("reads a lyrics file without its BOM and refuses an empty one", () => {
    const p = path.join(tmp, "lyrics.txt");
    fs.writeFileSync(p, "﻿[Chorus]\nla la\n");
    expect(readLyricsFile(p)).toBe("[Chorus]\nla la\n");
    fs.writeFileSync(p, "  \n");
    expect(() => readLyricsFile(p)).toThrow(/empty/);
    expect(() => readLyricsFile(path.join(tmp, "missing.txt"))).toThrow(/not found/);
  });

  it("inlines local images and refuses URLs and other types", () => {
    const png = path.join(tmp, "a.png");
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(readLyriaImages([png])).toEqual([{ data: "iVBORw==", mime_type: "image/png" }]);
    expect(() => readLyriaImages(["https://example.com/a.png"])).toThrow(/local file/);
    const txt = path.join(tmp, "a.txt");
    fs.writeFileSync(txt, "x");
    expect(() => readLyriaImages([txt])).toThrow(/PNG, JPEG/);
  });
});
