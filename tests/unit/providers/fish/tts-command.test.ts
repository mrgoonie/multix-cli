/**
 * `multix fish tts` and `fish voices` driven through commander with global
 * fetch stubbed: the exact model header (drama-3 by default, FISH_TTS_MODEL,
 * --model), the body for text, text files, turns and dictionaries, the saved
 * file and --json result, a 200 that is not audio, the key requirement, and
 * that neither the text nor the key reaches the logs. No network.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run as runState } from "../../../../src/agent/run-state.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerFishCommands } from "../../../../src/providers/fish/commands/index.js";
import { FISH_PUBLIC_VOICES } from "../../../../src/providers/fish/models.js";

const KEY = "fish-SECRET_KEY_VALUE";
const TEXT = "Một câu riêng tư không ai được ghi log.";
const VOICE_B = "2222333344445555666677778888aaaa";

/** Ten MPEG-1 Layer III frames (128 kbps, 44.1 kHz). */
function mp3(): Uint8Array {
  const buf = new Uint8Array(10 * 417);
  for (let f = 0; f < 10; f++) buf.set([0xff, 0xfb, 0x90, 0x64], f * 417);
  return buf;
}
const MP3 = mp3();

interface Call {
  method: string;
  url: string;
  headers: Headers;
  body?: Record<string, unknown>;
}

let tmp: string;
let output: string[];
let stdout: string[];
let calls: Call[];

function stubFetch(respond: (url: string) => Response) {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    return respond(url);
  });
}

const audio = (bytes: Uint8Array = MP3, type = "audio/mpeg") =>
  new Response(bytes, { headers: { "content-type": type } });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-fish-tts-"));
  vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(tmp, "out"));
  vi.stubEnv("FISH_API_KEY", KEY);
  vi.stubEnv("FISH_TTS_MODEL", "");
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
  runState.requestModel = undefined;
  runState.textFile = undefined;
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
  registerFishCommands(program);
  await program.parseAsync(["node", "multix", "fish", ...args]);
}

const allText = () => output.join("\n");
const jsonResult = () => JSON.parse(stdout.find((l) => l.startsWith("{")) ?? "{}");

describe("fish tts", () => {
  it("posts once to /v1/tts with the drama-3 header, saves the mp3 and reports it as JSON", async () => {
    stubFetch(() => audio());
    runState.json = true;
    await run("tts", "--text", TEXT, "--voice", "adrian", "-v");

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://api.fish.audio/v1/tts");
    expect(call?.headers.get("model")).toBe("drama-3");
    expect(call?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call?.body).toEqual({
      text: TEXT,
      format: "mp3",
      reference_id: FISH_PUBLIC_VOICES.adrian,
    });
    expect(runState.requestModel).toBe("drama-3");

    const bytes = new TextEncoder().encode(TEXT).byteLength;
    const result = jsonResult();
    expect(result).toMatchObject({
      provider: "fish",
      model_requested: "drama-3",
      model_header_sent: "drama-3",
      model_confirmed_by_response: false,
      voices: [FISH_PUBLIC_VOICES.adrian],
      speakers: 0,
      turns: null,
      input_chars: [...TEXT].length,
      input_utf8_bytes: bytes,
      format: "mp3",
      mime: "audio/mpeg",
      response_mime: "audio/mpeg",
      bytes: MP3.byteLength,
      signature_ok: true,
      sample_rate_hz: 44_100,
      duration_s: 0.261,
      duration_source: "frames",
      rate_id: "fish/drama-3@api",
      output: null,
    });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.text_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.estimated_cost_usd).toBeGreaterThan(0);
    expect(path.basename(result.path)).toMatch(/^fish_tts_.+\.mp3$/);
    expect(fs.readFileSync(result.path)).toEqual(Buffer.from(MP3));

    const logs = allText().replace(stdout.find((l) => l.startsWith("{")) ?? "", "");
    expect(logs).not.toContain(TEXT);
    expect(allText()).not.toContain(KEY);
  });

  it("sends the model from --model or FISH_TTS_MODEL, and refuses a misspelt one before sending", async () => {
    stubFetch(() => audio());
    vi.stubEnv("FISH_TTS_MODEL", "s2-pro");
    await run("tts", "--text", "Hi");
    await run("tts", "--text", "Hi", "--model", "s2.1-pro-free");
    expect(calls.map((c) => c.headers.get("model"))).toEqual(["s2-pro", "s2.1-pro-free"]);
    await expect(run("tts", "--text", "Hi", "--model", "drama3")).rejects.toThrow(/exact spelling/);
    expect(calls).toHaveLength(2);
  });

  it("prints the saved path in text mode and copies to --output", async () => {
    stubFetch(() => audio());
    const target = path.join(tmp, "copy", "line.mp3");
    await run("tts", "--text", "Hi", "--output", target);
    expect(fs.readFileSync(target)).toEqual(Buffer.from(MP3));
    expect(allText()).toMatch(/model header drama-3, mp3 44100 Hz, 0\.261s, 2 UTF-8 bytes/);
    expect(stdout.at(-1)).toMatch(/^\nGenerated audio: .*fish_tts_.+\.mp3$/);
  });

  it("builds tagged multi-speaker text from a turns file", async () => {
    stubFetch(() => audio());
    const turns = path.join(tmp, "turns.json");
    fs.writeFileSync(
      turns,
      JSON.stringify([
        { text: "Chào anh.", voice: "delia" },
        { text: "Chào em.", voice: VOICE_B },
        { text: "Đi thôi.", voice: "Delia" },
      ]),
    );
    runState.json = true;
    await run("tts", "--turns-file", turns, "--model", "s2.1-pro");
    expect(calls[0]?.body).toEqual({
      text: "<|speaker:0|>Chào anh.<|speaker:1|>Chào em.<|speaker:0|>Đi thôi.",
      format: "mp3",
      reference_id: [FISH_PUBLIC_VOICES.delia, VOICE_B],
    });
    expect(jsonResult()).toMatchObject({ speakers: 2, turns: 3 });
  });

  it("reads --text-file without a BOM and sends options and inline dictionaries", async () => {
    stubFetch(() => audio(new Uint8Array(4410 * 2), "audio/pcm"));
    const file = path.join(tmp, "line.txt");
    fs.writeFileSync(file, `﻿${TEXT}`);
    const dict = path.join(tmp, "dict.json");
    fs.writeFileSync(dict, JSON.stringify([{ key: "multix", value: "mul tix" }]));
    runState.json = true;
    await run(
      "tts",
      "--text-file",
      file,
      "--format",
      "pcm",
      "--sample-rate",
      "44100",
      "--speed",
      "1.1",
      "--no-normalize",
      "--language",
      "vi",
      "--latency",
      "normal",
      "--dictionary-file",
      dict,
    );
    expect(calls[0]?.body).toEqual({
      text: TEXT,
      format: "pcm",
      sample_rate: 44_100,
      prosody: { speed: 1.1 },
      normalize: false,
      language: "vi",
      latency: "normal",
      pronunciation_dictionary: [{ items: [{ key: "multix", value: "mul tix" }] }],
    });
    expect(jsonResult()).toMatchObject({
      format: "pcm",
      duration_s: 0.1,
      pronunciation_dictionaries: 1,
    });
  });

  it("sends the text the cost check read, without its BOM, not a second read", async () => {
    stubFetch(() => audio());
    const file = path.join(tmp, "priced.txt");
    runState.textFile = { path: file, text: `\uFEFF${TEXT}` };
    runState.json = true;
    await run("tts", "--text-file", file);
    expect(calls[0]?.body?.text).toBe(TEXT);

    const turns = path.join(tmp, "turns.json");
    runState.textFile = { path: turns, text: JSON.stringify([{ text: "Chào.", voice: VOICE_B }]) };
    await run("tts", "--turns-file", turns);
    expect(calls[1]?.body).toMatchObject({ text: "<|speaker:0|>Chào.", reference_id: [VOICE_B] });
  });

  it("sends pinned dictionary references and warns they may be skipped", async () => {
    stubFetch(() => audio());
    await run(
      "tts",
      "--text",
      "Hi",
      "--dictionary",
      "dict_a@ver_1",
      "--dictionary",
      "dict_b@ver_2",
    );
    expect(calls[0]?.body?.pronunciation_dictionary).toEqual([
      { id: "dict_a", version: "ver_1" },
      { id: "dict_b", version: "ver_2" },
    ]);
    expect(allText()).toMatch(/does not prove the dictionary was applied/);
  });

  it("refuses bad input before any request", async () => {
    stubFetch(() => audio());
    const dict = path.join(tmp, "dict.json");
    fs.writeFileSync(dict, "[]");
    await expect(run("tts")).rejects.toThrow(/--text, --text-file or --turns-file/);
    await expect(run("tts", "--text", "Hi", "--prompt", "Yo")).rejects.toThrow(/same flag/);
    await expect(
      run("tts", "--text", "Hi", "--dictionary", "a@b", "--dictionary-file", dict),
    ).rejects.toThrow(/cannot be combined/);
    await expect(run("tts", "--text", "Hi", "--voice", "a", "--voice", "b")).rejects.toThrow(
      /speaker:N/,
    );
    await expect(run("tts", "--text", "Hi", "--format", "flac")).rejects.toThrow(/--format/);
    await expect(run("tts", "--text", "Hi", "--speed", "fast")).rejects.toThrow(/number/);
    expect(calls).toHaveLength(0);
  });

  it("needs FISH_API_KEY and names where to get one", async () => {
    stubFetch(() => audio());
    vi.stubEnv("FISH_API_KEY", "");
    await expect(run("tts", "--text", "Hi")).rejects.toThrow(/FISH_API_KEY.*fish\.audio/s);
    expect(calls).toHaveLength(0);
  });

  it("keeps a 200 that is not the requested audio for inspection and fails", async () => {
    stubFetch(() => audio(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]), "audio/mpeg"));
    await expect(run("tts", "--text", "Hi")).rejects.toThrow(/not mp3 audio.*saved for inspection/);
    const saved = fs.readdirSync(path.join(tmp, "out")).filter((f) => f.startsWith("fish_tts_"));
    expect(saved).toHaveLength(1);
  });
});

describe("fish voices", () => {
  const MODEL = {
    _id: "aaaabbbbccccddddeeeeffff00001111",
    title: "Narrator",
    type: "tts",
    state: "trained",
    visibility: "private",
    train_mode: "fast",
    languages: ["en", "vi"],
    tags: [],
    created_at: "2026-10-01T00:00:00Z",
    author: { _id: "u1", nickname: "me" },
  };
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

  it("lists your own voices by default with the key", async () => {
    stubFetch(() => json({ total: 1, has_more: false, items: [MODEL] }));
    runState.json = true;
    await run("voices", "list", "--language", "vi");
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/model");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      self: "true",
      page_size: "20",
      page_number: "1",
      language: "vi",
    });
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(jsonResult()).toEqual({
      total: 1,
      has_more: false,
      items: [
        {
          id: MODEL._id,
          title: "Narrator",
          type: "tts",
          state: "trained",
          visibility: "private",
          train_mode: "fast",
          languages: ["en", "vi"],
          tags: [],
          created_at: "2026-10-01T00:00:00Z",
          author: "me",
        },
      ],
    });
  });

  it("works out has_more from the total when Fish sends null", async () => {
    stubFetch(() => json({ total: 45, has_more: null, items: [MODEL] }));
    runState.json = true;
    await run("voices", "list", "--page", "2");
    expect(jsonResult()).toMatchObject({ total: 45, has_more: true });
  });

  it("searches public voices and prints one line each", async () => {
    stubFetch(() => json({ total: 2, has_more: true, items: [MODEL] }));
    await run("voices", "list", "--public", "--title", "narr");
    expect(new URL(calls[0]?.url ?? "").searchParams.get("self")).toBeNull();
    expect(allText()).toContain(`${MODEL._id}  Narrator  (trained, private, en/vi)`);
    expect(allText()).toContain("more on --page 2");
  });

  it("reads one voice and refuses an id that is not one", async () => {
    stubFetch(() => json(MODEL));
    await run("voices", "get", MODEL._id);
    expect(calls[0]?.url).toBe(`https://api.fish.audio/model/${MODEL._id}`);
    await expect(run("voices", "get", "../x")).rejects.toThrow(/not a Fish Audio voice id/);
    await expect(run("voices", "list", "--page-size", "500")).rejects.toThrow(/--page-size/);
    expect(calls).toHaveLength(1);
  });
});
