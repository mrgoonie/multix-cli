/**
 * `multix elevenlabs tts` driven through commander with fetch stubbed: the
 * request body each model gets, rejection before any paid call, the
 * with-timestamps flow and the provider-reported character cost. No network.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerElevenLabsCommands } from "../../../../src/providers/elevenlabs/commands/index.js";

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0]);

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
  const capture = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };
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

function stubFetch(respond: (url: string) => Response): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return respond(url);
  });
}

function audioResponse(): Response {
  return new Response(MP3, {
    headers: { "content-type": "audio/mpeg", "character-cost": "12", "request-id": "req_1" },
  });
}

async function run(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: (s) => output.push(s), writeOut: (s) => output.push(s) });
  registerElevenLabsCommands(program);
  await program.parseAsync(["node", "multix", "elevenlabs", "tts", ...args]);
}

const text = () => output.join("\n");

describe("elevenlabs tts", () => {
  it("sends eleven_v4 with only the settings passed and reports the billed characters", async () => {
    stubFetch(audioResponse);
    await run("--text", "[whispering] Hello", "--model", "eleven_v4", "--stability", "0.3");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/v1/text-to-speech/");
    expect(requests[0]?.url).toContain("output_format=mp3_44100_128");
    expect(requests[0]?.body).toEqual({
      text: "[whispering] Hello",
      model_id: "eleven_v4",
      voice_settings: { stability: 0.3 },
    });
    expect(text()).toContain(
      "Billed by ElevenLabs: 12 characters (character-cost header, request-id req_1)",
    );
    const saved = fs.readdirSync(path.join(tmp, "out"));
    expect(saved.some((f) => f.endsWith(".mp3"))).toBe(true);
  });

  it("sends eleven_v4_turbo with clone strength", async () => {
    stubFetch(audioResponse);
    await run("--text", "Hi", "--model", "eleven_v4_turbo", "--clone-strength", "0.2");
    expect(requests[0]?.body).toEqual({
      text: "Hi",
      model_id: "eleven_v4_turbo",
      voice_settings: { clone_strength: 0.2 },
    });
  });

  it("rejects --style on eleven_v4 before any request", async () => {
    stubFetch(audioResponse);
    await expect(run("--text", "Hi", "--model", "eleven_v4", "--style", "0.5")).rejects.toThrow(
      /--style is not supported by eleven_v4/,
    );
    await expect(run("--text", "Hi", "--model", "eleven_v4", "--no-speaker-boost")).rejects.toThrow(
      /--speaker-boost\/--no-speaker-boost is not supported by eleven_v4/,
    );
    expect(requests).toHaveLength(0);
  });

  it("keeps the legacy default payload for eleven_multilingual_v2", async () => {
    stubFetch(audioResponse);
    await run("--text", "Hi");
    expect(requests[0]?.body).toEqual({
      text: "Hi",
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
    });
  });

  it("honours --no-speaker-boost and --speed on eleven_multilingual_v2", async () => {
    stubFetch(audioResponse);
    await run("--text", "Hi", "--no-speaker-boost", "--speed", "1.1");
    expect(requests[0]?.body.voice_settings).toEqual({
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0,
      use_speaker_boost: false,
      speed: 1.1,
    });
  });

  it("rejects an unknown --format before any request", async () => {
    stubFetch(audioResponse);
    await expect(run("--text", "Hi", "--format", "flac_44100")).rejects.toThrow(/Invalid --format/);
    expect(requests).toHaveLength(0);
  });

  it("saves wav output with a .wav extension", async () => {
    stubFetch(audioResponse);
    await run("--text", "Hi", "--model", "eleven_v4", "--format", "wav_22050");
    expect(requests[0]?.url).toContain("output_format=wav_22050");
    expect(fs.readdirSync(path.join(tmp, "out")).some((f) => f.endsWith(".wav"))).toBe(true);
  });

  it("--timestamps saves the decoded audio and the alignment JSON", async () => {
    const alignment = {
      characters: ["H", "i"],
      character_start_times_seconds: [0, 0.3],
      character_end_times_seconds: [0.3, 0.5],
    };
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            audio_base64: Buffer.from(MP3).toString("base64"),
            alignment,
            normalized_alignment: alignment,
          }),
          { headers: { "content-type": "application/json", "character-cost": "2" } },
        ),
    );
    await run("--text", "Hi", "--model", "eleven_v4", "--timestamps");
    expect(requests[0]?.url).toContain("/with-timestamps?");
    const files = fs.readdirSync(path.join(tmp, "out"));
    const audio = files.find((f) => f.endsWith(".mp3"));
    const json = files.find((f) => f.endsWith(".alignment.json"));
    expect(audio && fs.readFileSync(path.join(tmp, "out", audio))).toEqual(Buffer.from(MP3));
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "out", json ?? ""), "utf8"))).toEqual({
      alignment,
      normalized_alignment: alignment,
    });
    expect(text()).toContain("Billed by ElevenLabs: 2 characters");
  });
});
