/**
 * `multix elevenlabs tts` through commander with a stubbed fetch: the request
 * that reaches the API, saved audio, --timestamps alignment output, the
 * provider-reported character cost, and that rejected options send nothing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetEnvLoader } from "../../../../src/core/env-loader.js";
import { ValidationError } from "../../../../src/core/errors.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerElevenLabsCommands } from "../../../../src/providers/elevenlabs/commands/index.js";

let tmp: string;
let stdout: string[];
let stderr: string[];
let calls: Array<{ url: string; body: Record<string, unknown> }>;
const originalEnv = { ...process.env };

async function run(...args: string[]): Promise<void> {
  const p = new Command();
  p.exitOverride();
  registerElevenLabsCommands(p);
  await p.parseAsync(["node", "multix", "elevenlabs", "tts", ...args]);
}

function stubApi(response: () => Response): void {
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return response();
  });
}

const audio = () =>
  new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": "audio/mpeg", "character-cost": "3" },
  });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "elevenlabs-tts-"));
  process.env.MULTIX_OUTPUT_DIR = tmp;
  process.env.ELEVENLABS_API_KEY = "test-key";
  process.env.NO_COLOR = "1";
  _resetEnvLoader();
  _resetOutputDir();
  stdout = [];
  stderr = [];
  calls = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    stdout.push(a.join(" "));
  });
  for (const fn of ["error", "warn"] as const) {
    vi.spyOn(console, fn).mockImplementation((...a: unknown[]) => {
      stderr.push(a.join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  _resetEnvLoader();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("elevenlabs tts", () => {
  it("eleven_v4 sends only the settings it uses and reports the billed characters", async () => {
    stubApi(audio);
    await run("--text", "Hi.", "--model", "eleven_v4", "--clone-strength", "0", "--seed", "9");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/kdmDKE6EkgrWrrykO9Qt?output_format=mp3_44100_128",
    );
    expect(calls[0]?.body).toEqual({
      text: "Hi.",
      model_id: "eleven_v4",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, clone_strength: 0 },
      seed: 9,
    });
    const saved = fs.readdirSync(tmp).filter((f) => f.endsWith(".mp3"));
    expect(saved).toHaveLength(1);
    expect(stdout.join("\n")).toContain("Characters billed (provider-reported character-cost): 3");
  });

  it("rejects --style for eleven_v4_turbo before calling the API", async () => {
    stubApi(audio);
    await expect(
      run("--text", "Hi.", "--model", "eleven_v4_turbo", "--style", "0.5"),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it("keeps the default multilingual_v2 request unchanged", async () => {
    stubApi(audio);
    await run("--prompt", "Hello", "--no-speaker-boost");
    expect(calls[0]?.body).toEqual({
      text: "Hello",
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: false,
      },
    });
    expect(stderr).toEqual([]);
  });

  it("--timestamps decodes the audio and writes the alignment next to it and the --output copy", async () => {
    const alignment = {
      characters: ["H", "i"],
      character_start_times_seconds: [0, 0.2],
      character_end_times_seconds: [0.2, 0.4],
    };
    stubApi(
      () =>
        new Response(
          JSON.stringify({
            audio_base64: Buffer.from("AUDIO").toString("base64"),
            alignment,
            normalized_alignment: alignment,
          }),
          { headers: { "content-type": "application/json", "character-cost": "2" } },
        ),
    );
    const copy = path.join(tmp, "copy", "speech.wav");
    await run(
      "--text",
      "Hi",
      "--model",
      "eleven_v4_turbo",
      "--format",
      "wav_16000",
      "--timestamps",
      "--output",
      copy,
    );
    expect(calls[0]?.url).toContain("/text-to-speech/kdmDKE6EkgrWrrykO9Qt/with-timestamps?");
    const wav = fs.readdirSync(tmp).find((f) => f.endsWith(".wav"));
    expect(wav).toBeDefined();
    expect(fs.readFileSync(path.join(tmp, wav as string), "utf8")).toBe("AUDIO");
    expect(fs.readFileSync(copy, "utf8")).toBe("AUDIO");
    for (const f of [path.join(tmp, wav as string), copy]) {
      const json = JSON.parse(fs.readFileSync(f.replace(/\.wav$/, ".alignment.json"), "utf8"));
      expect(json.alignment).toEqual(alignment);
    }
    expect(stdout.join("\n")).toContain("character-cost): 2");
  });

  it("prints warnings for older models on stderr and still calls the API", async () => {
    stubApi(audio);
    await run("--text", "Hi", "--model", "eleven_flash_v2_5", "--style", "0.3");
    expect(calls).toHaveLength(1);
    expect(stderr.join("\n")).toContain("--style is not used by eleven_flash_v2_5");
  });

  it.each([
    ["not JSON", "<html>oops</html>"],
    ["JSON without audio", JSON.stringify({ alignment: {} })],
  ])("--timestamps keeps a billed %s response and fails as a provider error", async (_, body) => {
    stubApi(() => new Response(body, { headers: { "content-type": "application/json" } }));
    await expect(run("--text", "Hi", "--model", "eleven_v4", "--timestamps")).rejects.toThrow(
      /no audio with timestamps; raw response saved to/,
    );
    const raw = fs.readdirSync(tmp).find((f) => f.endsWith(".bin"));
    expect(raw).toBeDefined();
    expect(fs.readFileSync(path.join(tmp, raw as string), "utf8")).toBe(body);
  });
});
