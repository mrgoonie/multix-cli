import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, ProviderError, ValidationError } from "../../../../src/core/errors.js";
import { type ExternalRun, setExternalRunGuard } from "../../../../src/core/external-run-guard.js";
import type { Logger } from "../../../../src/core/logger.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import {
  type MusicLiveOptions,
  parseWeightedPromptFlag,
  registerGeminiMusicLiveCommand,
  runMusicLive,
} from "../../../../src/providers/gemini/commands/music-live.js";
import { _resetGeminiKeyCooldowns } from "../../../../src/providers/gemini/key-pool.js";
import { FakeLyriaSocket } from "./lyria-fake-socket.js";

const KEY = "AIzaSyTESTKEY-0123456789abcdef";
let tmp: string;
let output: string[];

function program(): Command {
  const root = new Command();
  root.exitOverride();
  registerGeminiMusicLiveCommand(root);
  return root;
}

async function cli(args: string[]): Promise<void> {
  await program().parseAsync(["music-live", ...args], { from: "user" });
}

async function cliError(args: string[]): Promise<unknown> {
  try {
    await cli(args);
  } catch (error) {
    return error;
  }
  throw new Error("expected music-live to throw");
}

function outputFiles(): string[] {
  const dir = path.join(tmp, "out");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function captureLogger(): Logger {
  const push = (m: string) => output.push(m);
  return { info: push, success: push, warn: push, error: push, debug: push, header: push };
}

function baseOpts(extra: Partial<MusicLiveOptions> = {}): MusicLiveOptions {
  return { prompt: ["ambient"], weightedPrompt: [], duration: "0.01", ...extra };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-music-live-"));
  output = [];
  _resetOutputDir();
  _resetGeminiKeyCooldowns();
  vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(tmp, "out"));
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GEMINI_API_KEY_")) vi.stubEnv(k, undefined);
  }
  vi.stubEnv("GEMINI_API_KEY", KEY);
  vi.stubGlobal("WebSocket", FakeLyriaSocket);
  FakeLyriaSocket.reset({});
  const capture = (msg?: unknown) => {
    output.push(String(msg));
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => {
  _resetOutputDir();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("gemini music-live command", () => {
  it("records to a valid 48k stereo WAV, copies --output, and never prints the key", async () => {
    const copy = path.join(tmp, "nested", "session.wav");
    const timeline = path.join(tmp, "timeline.json");
    fs.writeFileSync(
      timeline,
      JSON.stringify({ steps: [{ at: 0.005, prompts: [{ text: "drums", weight: 0.4 }] }] }),
    );
    FakeLyriaSocket.reset({ binary: true });
    const listenersBefore = process.listenerCount("SIGINT");

    await cli([
      "--prompt",
      "ambient synthwave",
      "--weighted-prompt",
      "warm: pads:0.5",
      "--prompts-file",
      timeline,
      "--duration",
      "0.01",
      "--bpm",
      "100",
      "--scale",
      "c_major_a_minor",
      "--mode",
      "quality",
      "--top-k",
      "50",
      "--mute-drums",
      "--output",
      copy,
    ]);

    const [file] = outputFiles();
    expect(file).toMatch(/^gemini_music_live_\d+-[0-9a-f]{8}\.wav$/);
    const wav = fs.readFileSync(path.join(tmp, "out", file as string));
    expect(wav.length).toBe(44 + 1920);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + 1920);
    expect(wav.subarray(8, 16).toString("ascii")).toBe("WAVEfmt ");
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(24)).toBe(48_000);
    expect(wav.readUInt32LE(28)).toBe(192_000);
    expect(wav.readUInt16LE(32)).toBe(4);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.subarray(36, 40).toString("ascii")).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(1920);
    expect(fs.readFileSync(copy)).toEqual(wav);

    const socket = FakeLyriaSocket.instances[0] as FakeLyriaSocket;
    const sent = socket.messages();
    expect(sent.slice(0, 4)).toEqual([
      { setup: { model: "models/lyria-realtime-exp" } },
      {
        clientContent: {
          weightedPrompts: [
            { text: "ambient synthwave", weight: 1 },
            { text: "warm: pads", weight: 0.5 },
          ],
        },
      },
      {
        musicGenerationConfig: {
          bpm: 100,
          topK: 50,
          scale: "C_MAJOR_A_MINOR",
          musicGenerationMode: "QUALITY",
          muteDrums: true,
        },
      },
      { playbackControl: "PLAY" },
    ]);
    expect(sent).toContainEqual({
      clientContent: { weightedPrompts: [{ text: "drums", weight: 0.4 }] },
    });
    expect(sent.at(-1)).toEqual({ playbackControl: "STOP" });
    expect(socket.closedWith?.code).toBe(1000);
    expect(process.listenerCount("SIGINT")).toBe(listenersBefore);

    const printed = output.join("\n");
    expect(printed).toContain(`Generated audio: ${path.join(tmp, "out", file as string)}`);
    expect(printed).toContain("Recorded: 0.0s");
    expect(printed).not.toContain(KEY);
  });

  it.each([
    [["--bpm", "250"], /--bpm/],
    [["--bpm", "90.5"], /--bpm must be an integer/],
    [["--density", "abc"], /--density must be a number/],
    [["--guidance", "7"], /--guidance/],
    [["--temperature", "-1"], /--temperature/],
    [["--top-k", "0"], /--top-k/],
    [["--seed", "2147483648"], /--seed/],
    [["--scale", "C_SHARP"], /--scale/],
    [["--mode", "fast"], /--mode/],
    [["--duration", "601"], /--duration must be > 0 and <= 600/],
    [["--duration", "0"], /--duration/],
    [["--model", "lyria-002"], /--model must be one of: lyria-realtime-exp/],
    [["--weighted-prompt", "x:0"], /weight must not be 0/],
    [["--weighted-prompt", "no weight"], /"text:weight"/],
  ])("rejects %j before connecting", async (args, message) => {
    const error = await cliError(["--prompt", "ambient", ...(args as string[])]);
    expect(error).toBeInstanceOf(ValidationError);
    expect(String(error)).toMatch(message as RegExp);
    expect(FakeLyriaSocket.instances).toHaveLength(0);
  });

  it("requires a prompt", async () => {
    const error = await cliError([]);
    expect(String(error)).toMatch(/At least one prompt/);
    expect(FakeLyriaSocket.instances).toHaveLength(0);
  });

  it("rejects an invalid prompts file before connecting", async () => {
    const file = path.join(tmp, "bad.json");
    for (const [content, message] of [
      ["{not json", /not valid JSON/],
      [JSON.stringify({ steps: [{ at: 0, prompt: "x" }] }), /Unrecognized key/],
      [JSON.stringify({ steps: [{ at: 40, config: { bpm: 90 } }] }), /below --duration/],
    ] as const) {
      fs.writeFileSync(file, content);
      const error = await cliError(["--prompt", "a", "--prompts-file", file, "--duration", "30"]);
      expect(error).toBeInstanceOf(ValidationError);
      expect(String(error)).toMatch(message);
    }
    const missing = await cliError(["--prompt", "a", "--prompts-file", path.join(tmp, "nope")]);
    expect(String(missing)).toMatch(/Cannot read --prompts-file/);
    expect(FakeLyriaSocket.instances).toHaveLength(0);
  });

  it("stops at the external-run guard before connecting, without the key", async () => {
    const seen: ExternalRun[] = [];
    setExternalRunGuard((run) => {
      seen.push(run);
      throw new Error("dry run");
    });
    try {
      await expect(cli(["--prompt", "a"])).rejects.toThrow("dry run");
    } finally {
      setExternalRunGuard(() => {});
    }
    expect(FakeLyriaSocket.instances).toHaveLength(0);
    expect(seen).toEqual([
      {
        method: "WEBSOCKET",
        program:
          "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateMusic",
        args: ['{"setup":{"model":"models/lyria-realtime-exp"}}'],
      },
    ]);
    expect(JSON.stringify(seen)).not.toContain(KEY);
    expect(outputFiles()).toEqual([]);
  });

  it("explains that Node 22 is needed when there is no global WebSocket", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const error = await cliError(["--prompt", "a"]);
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toMatch(/needs Node 22 or newer \(built-in WebSocket\)/);
  });

  it("fails without leaving a file when no audio arrives", async () => {
    FakeLyriaSocket.reset({ maxChunks: 0, closeAfterChunks: { code: 1011, reason: "boom" } });
    const error = await cliError(["--prompt", "a"]);
    expect(error).toBeInstanceOf(ProviderError);
    expect(String(error)).toMatch(/code 1011: boom/);
    expect(outputFiles()).toEqual([]);
  });

  it("fails on a normal close with no audio", async () => {
    FakeLyriaSocket.reset({ maxChunks: 0, closeAfterChunks: { code: 1000, reason: "" } });
    const error = await cliError(["--prompt", "a"]);
    expect(String(error)).toMatch(/Lyria returned no audio/);
    expect(outputFiles()).toEqual([]);
  });

  it("keeps a valid partial WAV when the server drops mid-stream", async () => {
    FakeLyriaSocket.reset({
      maxChunks: 1,
      chunkBytes: 962, // odd tail: the finalizer drops the partial frame
      closeAfterChunks: { code: 1011, reason: "internal" },
    });
    const result = await runMusicLive(baseOpts({ duration: "5" }), { logger: captureLogger() });
    expect(result.endReason).toBe("server-closed");
    const wav = fs.readFileSync(result.path);
    expect(wav.length).toBe(44 + 960);
    expect(wav.readUInt32LE(40)).toBe(960);
    expect(wav.readUInt32LE(4)).toBe(36 + 960);
    expect(result.seconds).toBeCloseTo(0.005);
    expect(output.join("\n")).toMatch(/Recording ended early: .*code 1011/);
  });

  it("stops on an abort signal (as on SIGINT) and saves the partial recording", async () => {
    FakeLyriaSocket.reset({ maxChunks: 3 });
    const controller = new AbortController();
    const listenersBefore = process.listenerCount("SIGTERM");
    const run = runMusicLive(baseOpts({ duration: "60" }), {
      signal: controller.signal,
      logger: captureLogger(),
    });
    await vi.waitFor(() => expect(FakeLyriaSocket.instances[0]?.messages().length).toBe(4));
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const result = await run;
    expect(result.endReason).toBe("aborted");
    const wav = fs.readFileSync(result.path);
    expect(wav.readUInt32LE(40)).toBe(3 * 960);
    expect(wav.length).toBe(44 + 3 * 960);
    const socket = FakeLyriaSocket.instances[0] as FakeLyriaSocket;
    expect(socket.messages().at(-1)).toEqual({ playbackControl: "STOP" });
    expect(socket.closedWith?.code).toBe(1000);
    expect(process.listenerCount("SIGTERM")).toBe(listenersBefore);
  });

  it("reports a stop before any audio as cancelled", async () => {
    FakeLyriaSocket.reset({ completeSetup: false });
    const controller = new AbortController();
    const run = runMusicLive(baseOpts(), { signal: controller.signal, logger: captureLogger() });
    await vi.waitFor(() => expect(FakeLyriaSocket.instances[0]?.messages().length).toBe(1));
    controller.abort();
    await expect(run).rejects.toThrow(/Stopped before Lyria sent any audio/);
    expect(outputFiles()).toEqual([]);
  });

  it("times out an idle stream and keeps the audio", async () => {
    FakeLyriaSocket.reset({ maxChunks: 1 });
    const result = await runMusicLive(baseOpts({ duration: "5" }), {
      idleTimeoutMs: 30,
      logger: captureLogger(),
    });
    expect(result.endReason).toBe("idle-timeout");
    expect(fs.readFileSync(result.path).readUInt32LE(40)).toBe(960);
  });

  it("times out a setup that never completes", async () => {
    FakeLyriaSocket.reset({ completeSetup: false });
    await expect(
      runMusicLive(baseOpts(), { setupTimeoutMs: 20, logger: captureLogger() }),
    ).rejects.toThrow(/did not complete setup within 0.02s/);
    expect(outputFiles()).toEqual([]);
  });
});

describe("parseWeightedPromptFlag", () => {
  it("splits at the last colon", () => {
    expect(parseWeightedPromptFlag("a: b:-0.25")).toEqual({ text: "a: b", weight: -0.25 });
  });

  it("rejects missing text or weight", () => {
    expect(() => parseWeightedPromptFlag(":1")).toThrow(ValidationError);
    expect(() => parseWeightedPromptFlag("text:")).toThrow(ValidationError);
    expect(() => parseWeightedPromptFlag("text:abc")).toThrow(ValidationError);
  });
});
