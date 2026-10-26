/**
 * `multix elevenlabs tts` driven through commander with global fetch stubbed:
 * the body each model gets, validation before any request, /with-timestamps
 * output, and credits printed only from the provider's character-cost header.
 * No network or paid calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerElevenLabsCommands } from "../../../../src/providers/elevenlabs/commands/index.js";

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]);

let tmp: string;
let output: string[];
let requests: Array<{ url: string; body: Record<string, unknown> }>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-elevenlabs-tts-"));
  vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(tmp, "out"));
  vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
  vi.stubEnv("NO_COLOR", "1");
  _resetOutputDir();
  output = [];
  requests = [];
  const capture = (...args: unknown[]) => output.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function stubFetch(response: () => Response) {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return response();
  });
}

const audioResponse = (headers: Record<string, string> = { "character-cost": "2" }) =>
  new Response(MP3, { status: 200, headers: { "content-type": "audio/mpeg", ...headers } });

async function run(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: (s) => output.push(s), writeOut: (s) => output.push(s) });
  registerElevenLabsCommands(program);
  await program.parseAsync(["node", "multix", "elevenlabs", "tts", ...args]);
}

const text = () => output.join("\n");

describe("elevenlabs tts", () => {
  it("eleven_v4_turbo: sends a v4 body and reports provider-charged credits", async () => {
    stubFetch(() => audioResponse());
    await run("--text", "Hi.", "--model", "eleven_v4_turbo", "--stability", "0.4");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/v1/text-to-speech/kdmDKE6EkgrWrrykO9Qt?");
    expect(requests[0]?.url).toContain("output_format=mp3_44100_128");
    expect(requests[0]?.body).toEqual({
      text: "Hi.",
      model_id: "eleven_v4_turbo",
      voice_settings: { stability: 0.4, similarity_boost: 0.75 },
    });
    expect(text()).toMatch(/Generated audio: .*elevenlabs_tts_.*\.mp3/);
    expect(text()).toContain("Credits charged (ElevenLabs character-cost header): 2");
  });

  it("default model keeps the legacy multilingual v2 body", async () => {
    stubFetch(() => audioResponse());
    await run("--text", "Hello");
    expect(requests[0]?.body).toEqual({
      text: "Hello",
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
    });
  });

  it("prints no credit line when the provider reports none (never estimates)", async () => {
    stubFetch(() => audioResponse({}));
    await run("--text", "Hi.", "--model", "eleven_v4");
    expect(text()).not.toMatch(/Credits charged/);
  });

  it("rejects an option the model would ignore before sending anything", async () => {
    stubFetch(() => audioResponse());
    await expect(run("--text", "Hi.", "--model", "eleven_v4", "--style", "0.5")).rejects.toThrow(
      /eleven_v4 has no style control/,
    );
    expect(requests).toHaveLength(0);
  });

  it("warns for --no-speaker-boost on v4 and still generates", async () => {
    stubFetch(() => audioResponse());
    await run("--text", "Hi.", "--model", "eleven_v4", "--no-speaker-boost");
    expect(text()).toMatch(/eleven_v4 has no speaker boost/);
    expect(requests[0]?.body.voice_settings).toEqual({ stability: 0.5, similarity_boost: 0.75 });
  });

  it("--timestamps saves the decoded audio and the alignment JSON", async () => {
    const alignment = {
      characters: ["H", "i"],
      character_start_times_seconds: [0, 0.2],
      character_end_times_seconds: [0.2, 0.4],
    };
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            audio_base64: Buffer.from(MP3).toString("base64"),
            alignment,
            normalized_alignment: alignment,
          }),
          { status: 200, headers: { "content-type": "application/json", "character-cost": "3" } },
        ),
    );
    await run("--text", "Hi", "--model", "eleven_v4", "--format", "wav_22050", "--timestamps");
    expect(requests[0]?.url).toContain("/with-timestamps?output_format=wav_22050");
    const audioPath = text().match(/Generated audio: (\S+)/)?.[1] ?? "";
    expect(audioPath.endsWith(".wav")).toBe(true);
    expect(new Uint8Array(fs.readFileSync(audioPath))).toEqual(MP3);
    const timings = JSON.parse(fs.readFileSync(`${audioPath}.timestamps.json`, "utf8"));
    expect(timings.alignment).toEqual(alignment);
    expect(text()).toContain("Credits charged (ElevenLabs character-cost header): 3");
  });

  it("--timestamps with --output also writes timings next to the copy", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ audio_base64: Buffer.from(MP3).toString("base64"), alignment: {} }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const copy = path.join(tmp, "voice.mp3");
    await run("--text", "Hi", "--model", "eleven_v4", "--timestamps", "--output", copy);
    expect(new Uint8Array(fs.readFileSync(copy))).toEqual(MP3);
    expect(JSON.parse(fs.readFileSync(`${copy}.timestamps.json`, "utf8"))).toEqual({
      alignment: {},
    });
  });

  it("--timestamps keeps the raw body of a billed response without JSON audio", async () => {
    stubFetch(() => audioResponse());
    const notJson = run("--text", "Hi", "--model", "eleven_v4", "--timestamps");
    await expect(notJson).rejects.toThrow(
      /with-timestamps response was not JSON; raw response saved to \S+elevenlabs_tts_raw_\S+\.bin/,
    );
    const noAudio = JSON.stringify({ alignment: {} });
    stubFetch(
      () => new Response(noAudio, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const err = await run("--text", "Hi", "--model", "eleven_v4", "--timestamps").catch(
      (e: Error) => e,
    );
    expect(String(err)).toMatch(/carried no audio; raw response saved to/);
    const raw = String(err).match(/saved to (\S+\.bin)/)?.[1] ?? "";
    expect(fs.readFileSync(raw, "utf8")).toBe(noAudio);
    const saved = fs.readdirSync(path.join(tmp, "out"));
    expect(saved.filter((f) => f.endsWith(".bin"))).toHaveLength(2);
    expect(saved.filter((f) => f.endsWith(".mp3"))).toHaveLength(0);
  });

  it("--clone-strength reaches the v4 body and is rejected for other models", async () => {
    stubFetch(() => audioResponse());
    await run("--text", "Hi", "--model", "eleven_v4", "--clone-strength", "0.2");
    expect(requests[0]?.body.voice_settings).toEqual({
      stability: 0.5,
      similarity_boost: 0.75,
      clone_strength: 0.2,
    });
    await expect(run("--text", "Hi", "--clone-strength", "0.2")).rejects.toThrow(
      /eleven_multilingual_v2 does not accept --clone-strength/,
    );
    expect(requests).toHaveLength(1);
  });

  it("rejects a malformed voice ID before sending anything", async () => {
    stubFetch(() => audioResponse());
    await expect(run("--text", "Hi", "--voice", "..")).rejects.toThrow(
      /--voice must be an ElevenLabs voice ID/,
    );
    expect(requests).toHaveLength(0);
  });

  it("warns about SSML the model does not perform and still generates", async () => {
    stubFetch(() => audioResponse());
    await run("--text", 'Hi <break time="1s"/> there', "--model", "eleven_v4");
    expect(text()).toMatch(/eleven_v4 skips SSML <break> tags/);
    expect(requests).toHaveLength(1);
  });
});
