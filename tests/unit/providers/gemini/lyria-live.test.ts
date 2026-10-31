import { beforeEach, describe, expect, it } from "vitest";
import { ProviderError, ValidationError } from "../../../../src/core/errors.js";
import type { Logger } from "../../../../src/core/logger.js";
import {
  type LyriaLiveSessionOptions,
  type LyriaPlanStep,
  buildLyriaLiveUrl,
  buildLyriaPlan,
  frameText,
  lyriaConfigMessage,
  lyriaPromptsMessage,
  lyriaSetupMessage,
  parseLyriaServerMessage,
  parseLyriaTimeline,
  parsePcmFormat,
  runLyriaLiveSession,
  validateLyriaConfig,
} from "../../../../src/providers/gemini/lyria-live.js";
import { FakeLyriaSocket, audioFrame, pcmBytes } from "./lyria-fake-socket.js";

const KEY = "AIzaSyTESTKEY-0123456789abcdef";
const tick = () => new Promise((r) => setTimeout(r, 0));
async function ticks(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}

function captureLogger(lines: string[]): Logger {
  const push = (m: string) => lines.push(m);
  return { info: push, success: push, warn: push, error: push, debug: push, header: push };
}

describe("lyria-live message builders", () => {
  it("builds the BidiGenerateMusic URL with the key in the query", () => {
    expect(buildLyriaLiveUrl("k/y")).toBe(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateMusic?key=k%2Fy",
    );
  });

  it("prefixes the model and serializes prompts/config in camelCase", () => {
    expect(JSON.parse(lyriaSetupMessage("lyria-realtime-exp"))).toEqual({
      setup: { model: "models/lyria-realtime-exp" },
    });
    expect(JSON.parse(lyriaPromptsMessage([{ text: "pads", weight: 0.5 }]))).toEqual({
      clientContent: { weightedPrompts: [{ text: "pads", weight: 0.5 }] },
    });
    expect(JSON.parse(lyriaConfigMessage({ bpm: 90, topK: 40, muteBass: true }))).toEqual({
      musicGenerationConfig: { bpm: 90, topK: 40, muteBass: true },
    });
  });

  it("parses PCM format from the mime type with 48k stereo defaults", () => {
    expect(parsePcmFormat("audio/l16;rate=24000;channels=1")).toEqual({
      sampleRate: 24_000,
      channels: 1,
    });
    expect(parsePcmFormat("audio/l16")).toEqual({ sampleRate: 48_000, channels: 2 });
    expect(parsePcmFormat(undefined)).toEqual({ sampleRate: 48_000, channels: 2 });
  });

  it("decodes text, ArrayBuffer, typed-array and Blob frames", async () => {
    const json = '{"setupComplete":{}}';
    const bytes = new TextEncoder().encode(json);
    expect(await frameText(json)).toBe(json);
    expect(await frameText(bytes.buffer)).toBe(json);
    expect(await frameText(Buffer.from(json))).toBe(json);
    expect(await frameText(new Blob([json]))).toBe(json);
    await expect(frameText(42)).rejects.toBeInstanceOf(ProviderError);
  });

  it("parses audio chunks, filtered prompts and warnings", () => {
    const pcm = pcmBytes(8);
    const [audio] = parseLyriaServerMessage(JSON.stringify(audioFrame(pcm)));
    expect(audio).toEqual({
      type: "audio",
      chunks: [{ pcm, format: { sampleRate: 48_000, channels: 2 } }],
    });
    expect(
      parseLyriaServerMessage(
        JSON.stringify({ filteredPrompt: { text: "x", filteredReason: "SAFETY" } }),
      ),
    ).toEqual([{ type: "filteredPrompt", text: "x", reason: "SAFETY" }]);
    expect(parseLyriaServerMessage('{"warning":"slow"}')).toEqual([
      { type: "warning", message: "slow" },
    ]);
    expect(() => parseLyriaServerMessage("not json")).toThrow(ProviderError);
  });
});

describe("lyria-live validation", () => {
  it("accepts a full valid config and rejects out-of-range values", () => {
    const ok = {
      guidance: 6,
      bpm: 200,
      density: 0,
      brightness: 1,
      scale: "D_MAJOR_B_MINOR",
      muteBass: true,
      muteDrums: false,
      onlyBassAndDrums: false,
      musicGenerationMode: "VOCALIZATION",
      temperature: 3,
      topK: 1000,
      seed: 2_147_483_647,
    };
    expect(validateLyriaConfig(ok)).toEqual(ok);
    for (const bad of [
      { bpm: 59 },
      { bpm: 120.5 },
      { guidance: 6.1 },
      { density: -0.1 },
      { temperature: 3.5 },
      { topK: 0 },
      { seed: -1 },
      { scale: "C_SHARP" },
      { musicGenerationMode: "FAST" },
      { unknown: 1 },
    ]) {
      expect(() => validateLyriaConfig(bad)).toThrow(ValidationError);
    }
  });

  it("validates a timeline strictly", () => {
    const good = {
      steps: [
        { at: 0, prompts: [{ text: "a" }], config: { bpm: 100 } },
        { at: 10, prompts: [{ text: "b", weight: -0.5 }] },
      ],
    };
    expect(parseLyriaTimeline(good, 30).steps[0]?.prompts?.[0]?.weight).toBe(1);

    const bad: Array<[unknown, RegExp]> = [
      [{ steps: [] }, /steps/],
      [{ steps: [{ at: 0, prompts: [{ text: "a" }] }], extra: 1 }, /Unrecognized key/],
      [{ steps: [{ at: 0, prompts: [{ text: "a", weight: 0 }] }] }, /weight must not be 0/],
      [{ steps: [{ at: 0, prompts: [{ text: " " }] }] }, /must not be empty/],
      [{ steps: [{ at: 0 }] }, /prompts, config, or both/],
      [{ steps: [{ at: -1, config: { bpm: 90 } }] }, /at/],
      [{ steps: [{ at: 0, config: { bpm: 300 } }] }, /bpm/],
      [{ steps: [{ at: 0, prompts: [{ text: "a", w: 1 }] }] }, /Unrecognized key/],
      [
        {
          steps: [
            { at: 5, config: { bpm: 90 } },
            { at: 5, config: { bpm: 100 } },
          ],
        },
        /greater than/,
      ],
      [{ steps: [{ at: 30, config: { bpm: 90 } }] }, /below --duration/],
    ];
    for (const [json, msg] of bad) {
      expect(() => parseLyriaTimeline(json, 30)).toThrow(msg);
    }
  });

  it("builds a plan with merged configs and resets context on bpm/scale changes", () => {
    const timeline = parseLyriaTimeline(
      {
        steps: [
          { at: 5, config: { density: 0.2 } },
          { at: 10, prompts: [{ text: "b" }], config: { bpm: 140 } },
        ],
      },
      30,
    );
    const plan = buildLyriaPlan([{ text: "a", weight: 1 }], { bpm: 90 }, timeline);
    expect(plan).toEqual([
      { at: 0, prompts: [{ text: "a", weight: 1 }], config: { bpm: 90 }, resetContext: false },
      { at: 5, config: { bpm: 90, density: 0.2 }, resetContext: false },
      {
        at: 10,
        prompts: [{ text: "b", weight: 1 }],
        config: { bpm: 140, density: 0.2 },
        resetContext: true,
      },
    ]);
  });

  it("takes prompts at 0 from the file or the flags, never both, and requires some", () => {
    const fileAt0 = parseLyriaTimeline(
      { steps: [{ at: 0, prompts: [{ text: "f" }], config: { seed: 3 } }] },
      30,
    );
    expect(buildLyriaPlan([], { bpm: 90 }, fileAt0)).toEqual([
      {
        at: 0,
        prompts: [{ text: "f", weight: 1 }],
        config: { bpm: 90, seed: 3 },
        resetContext: false,
      },
    ]);
    expect(() => buildLyriaPlan([{ text: "a", weight: 1 }], {}, fileAt0)).toThrow(/conflict/);
    expect(() => buildLyriaPlan([], {})).toThrow(/At least one prompt/);
  });
});

describe("runLyriaLiveSession", () => {
  let socket: FakeLyriaSocket;
  let logs: string[];
  let warnings: string[];
  let audio: Uint8Array[];

  beforeEach(() => {
    FakeLyriaSocket.reset();
    logs = [];
    warnings = [];
    audio = [];
  });

  const plan: LyriaPlanStep[] = [
    { at: 0, prompts: [{ text: "ambient", weight: 1 }], config: { bpm: 90 }, resetContext: false },
    { at: 0.005, prompts: [{ text: "drums", weight: 0.5 }], resetContext: false },
    { at: 0.008, config: { bpm: 120 }, resetContext: true },
  ];

  function start(extra: Partial<LyriaLiveSessionOptions> = {}) {
    const promise = runLyriaLiveSession({
      apiKey: KEY,
      model: "lyria-realtime-exp",
      plan,
      durationSec: 0.01, // 480 frames * 2 ch * 2 bytes = 1920 bytes
      createSocket: (url) => {
        socket = new FakeLyriaSocket(url);
        return socket;
      },
      onAudio: async (pcm) => {
        await tick();
        audio.push(pcm);
      },
      onWarning: (m) => warnings.push(m),
      logger: captureLogger(logs),
      ...extra,
    });
    return promise;
  }

  async function openAndSetup(): Promise<void> {
    await tick();
    socket.open();
    socket.serverSend({ setupComplete: {} });
    await ticks();
  }

  it("runs setup, sends prompts/config/PLAY, applies steps, and stops at the duration", async () => {
    const done = start();
    await tick();
    expect(socket.url).toContain("BidiGenerateMusic?key=");
    expect(socket.binaryType).toBe("arraybuffer");
    socket.open();
    await ticks();
    // Nothing but setup until the server confirms it.
    expect(socket.messages()).toEqual([{ setup: { model: "models/lyria-realtime-exp" } }]);

    socket.serverSend({ setupComplete: {} });
    await ticks();
    expect(socket.messages().slice(1)).toEqual([
      { clientContent: { weightedPrompts: [{ text: "ambient", weight: 1 }] } },
      { musicGenerationConfig: { bpm: 90 } },
      { playbackControl: "PLAY" },
    ]);

    socket.serverSend(audioFrame(pcmBytes(960, 1))); // text frame, 0.005s
    socket.serverSend(audioFrame(pcmBytes(800, 2)), true); // binary frame, 0.00917s
    socket.serverSend(audioFrame(pcmBytes(960, 3))); // only 160 bytes fit
    socket.serverSend(audioFrame(pcmBytes(960, 4))); // ignored after finish
    const result = await done;

    expect(result).toMatchObject({
      bytes: 1920,
      endReason: "duration",
      format: { sampleRate: 48_000, channels: 2 },
      filteredPrompts: 0,
    });
    expect(result.seconds).toBeCloseTo(0.01);
    expect(result.error).toBeUndefined();
    expect(audio.map((a) => a.length)).toEqual([960, 800, 160]);
    expect(Buffer.from(audio[0] as Uint8Array)).toEqual(Buffer.from(pcmBytes(960, 1)));

    expect(socket.messages().slice(4)).toEqual([
      { clientContent: { weightedPrompts: [{ text: "drums", weight: 0.5 }] } },
      { musicGenerationConfig: { bpm: 120 } },
      { playbackControl: "RESET_CONTEXT" },
      { playbackControl: "STOP" },
    ]);
    expect(socket.closedWith?.code).toBe(1000);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("warns about filtered prompts and server warnings", async () => {
    const done = start();
    await openAndSetup();
    socket.serverSend({ filteredPrompt: { text: "bad words", filteredReason: "SAFETY" } });
    socket.serverSend({ warning: `quota near limit ?key=${KEY}` });
    socket.serverSend(audioFrame(pcmBytes(1920)));
    const result = await done;
    expect(result.filteredPrompts).toBe(1);
    expect(warnings[0]).toMatch(/filtered the prompt "bad words" \(SAFETY\)/);
    expect(warnings[1]).toMatch(/Lyria warning/);
    expect(warnings.join("\n")).not.toContain(KEY);
  });

  it("stops cleanly on abort and keeps what was recorded", async () => {
    const controller = new AbortController();
    const done = start({ signal: controller.signal });
    await openAndSetup();
    socket.serverSend(audioFrame(pcmBytes(480)));
    await ticks();
    controller.abort();
    const result = await done;
    expect(result).toMatchObject({ bytes: 480, endReason: "aborted" });
    expect(result.error).toBeUndefined();
    expect(socket.messages().at(-1)).toEqual({ playbackControl: "STOP" });
    expect(socket.closedWith?.code).toBe(1000);
  });

  it("does not connect when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await start({ signal: controller.signal });
    expect(result.endReason).toBe("aborted");
    expect(FakeLyriaSocket.instances).toHaveLength(0);
  });

  it("fails the setup on timeout", async () => {
    const done = start({ setupTimeoutMs: 20 });
    await tick();
    socket.open();
    const result = await done;
    expect(result.endReason).toBe("setup-failed");
    expect(result.error?.message).toMatch(/did not complete setup/);
    expect(socket.closedWith?.code).toBe(1000);
  });

  it("stops after the idle timeout when audio stalls", async () => {
    const done = start({ idleTimeoutMs: 30 });
    await openAndSetup();
    socket.serverSend(audioFrame(pcmBytes(480)));
    const result = await done;
    expect(result).toMatchObject({ bytes: 480, endReason: "idle-timeout" });
    expect(result.error?.message).toMatch(/no audio for 0\.03s/);
  });

  it("reports a close before setup without leaking the key", async () => {
    const done = start();
    await tick();
    socket.open();
    socket.serverClose(1008, `API key not valid: ${KEY}`);
    const result = await done;
    expect(result.endReason).toBe("setup-failed");
    expect(result.error).toBeInstanceOf(ProviderError);
    expect(result.error?.message).toMatch(/before setup completed \(code 1008/);
    expect(result.error?.message).not.toContain(KEY);
  });

  it("keeps audio when the server closes abnormally mid-stream", async () => {
    const done = start();
    await openAndSetup();
    socket.serverSend(audioFrame(pcmBytes(480)), true);
    socket.emitError();
    socket.serverClose(1011, "internal");
    const result = await done;
    expect(result).toMatchObject({ bytes: 480, endReason: "server-closed" });
    expect(result.error?.message).toMatch(/code 1011: internal, after a WebSocket error/);
  });

  it("treats a normal server close as the end of the stream", async () => {
    const done = start();
    await openAndSetup();
    socket.serverSend(audioFrame(pcmBytes(480)));
    socket.serverClose(1000);
    const result = await done;
    expect(result).toMatchObject({ bytes: 480, endReason: "server-closed" });
    expect(result.error).toBeUndefined();
  });

  it("ends with an error when onAudio fails", async () => {
    const done = start({
      onAudio: () => {
        throw new Error("disk full");
      },
    });
    await openAndSetup();
    socket.serverSend(audioFrame(pcmBytes(480)));
    const result = await done;
    expect(result).toMatchObject({ bytes: 0, endReason: "error" });
    expect(result.error?.message).toBe("disk full");
    expect(socket.closedWith?.code).toBe(1000);
  });

  it("reports a socket factory failure", async () => {
    const result = await start({
      createSocket: () => {
        throw new Error(`bad url ?key=${KEY}`);
      },
    });
    expect(result.endReason).toBe("setup-failed");
    expect(result.error?.message).not.toContain(KEY);
  });
});
