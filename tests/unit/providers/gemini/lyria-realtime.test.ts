/**
 * Lyria RealTime: plan validation, the WebSocket session against a fake
 * socket (setup, prompts, config, timed changes, trimming, early close, idle
 * timeout, key scrubbing), the streaming WAV writer, and the Node recorder
 * with an injected socket. No network.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../../../src/agent/run-state.js";
import { ValidationError } from "../../../../src/core/errors.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { planFromFlags } from "../../../../src/providers/gemini/commands/music-live.js";
import {
  StreamingWavWriter,
  recordGeminiMusicLive,
} from "../../../../src/providers/gemini/generators/music-live.js";
import { _resetGeminiKeyCooldowns } from "../../../../src/providers/gemini/key-pool.js";
import {
  LyriaRealtimeSession,
  REALTIME_BYTES_PER_SECOND,
  type SessionPlan,
  type WebSocketLike,
  checkChunkMime,
  parsePromptsFile,
  validateMusicConfig,
  validateSessionPlan,
  validateWeightedPrompts,
} from "../../../../src/providers/gemini/lyria-realtime.js";

type Listener = (event?: unknown) => void;

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | undefined;
  private listeners: Record<string, Listener[]> = {};

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners[type] ?? [];
    list.push(listener);
    this.listeners[type] = list;
  }

  emit(type: string, event?: unknown): void {
    for (const l of this.listeners[type] ?? []) l(event);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  /** Server messages arrive as binary JSON frames. */
  message(msg: unknown): void {
    this.emit("message", { data: new TextEncoder().encode(JSON.stringify(msg)).buffer });
  }

  audio(bytes: number, mimeType = "audio/l16;rate=48000;channels=2"): void {
    this.message({
      serverContent: {
        audioChunks: [{ data: Buffer.alloc(bytes, 7).toString("base64"), mimeType }],
      },
    });
  }
}

/** Manual timers: `fire()` runs the armed callback. */
function manualTimers() {
  let pending: (() => void) | undefined;
  return {
    setTimer: (fn: () => void) => {
      pending = fn;
      return fn;
    },
    clearTimer: (h: unknown) => {
      if (pending === h) pending = undefined;
    },
    fire: () => pending?.(),
  };
}

const ONE_SECOND = REALTIME_BYTES_PER_SECOND;

function plan(extra: Partial<SessionPlan> = {}): SessionPlan {
  return { prompts: [{ text: "minimal techno", weight: 1 }], durationSeconds: 2, ...extra };
}

function session(p: SessionPlan, apiKey = "rt-key/0001") {
  let socket: FakeSocket | undefined;
  const timers = manualTimers();
  const audio: Uint8Array[] = [];
  const filtered: string[] = [];
  const changes: number[] = [];
  const s = new LyriaRealtimeSession({
    apiKey,
    plan: p,
    createWebSocket: (url) => {
      socket = new FakeSocket(url);
      return socket;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    events: {
      onAudio: (pcm) => audio.push(pcm),
      onFilteredPrompt: (text, reason) => filtered.push(`${reason}:${text}`),
      onChange: (c) => changes.push(c.at),
    },
  });
  const promise = s.start();
  return { s, promise, ws: () => socket as FakeSocket, timers, audio, filtered, changes };
}

describe("RealTime plan validation", () => {
  it("accepts snake_case config and refuses unknown or out-of-range fields", () => {
    expect(validateMusicConfig({ top_k: 40, mute_bass: true, bpm: 120 })).toEqual({
      topK: 40,
      muteBass: true,
      bpm: 120,
    });
    expect(() => validateMusicConfig({ volume: 1 })).toThrow(ValidationError);
    expect(() => validateMusicConfig({ bpm: 59 })).toThrow(/bpm/);
    expect(() => validateMusicConfig({ bpm: 120.5 })).toThrow(/bpm/);
    expect(() => validateMusicConfig({ guidance: 6.5 })).toThrow(/guidance/);
    expect(() => validateMusicConfig({ scale: "H_MAJOR" })).toThrow(/scale/);
  });

  it("needs non-empty prompts with a positive total weight", () => {
    expect(validateWeightedPrompts([{ text: "jazz" }])).toEqual([{ text: "jazz", weight: 1 }]);
    expect(() => validateWeightedPrompts([])).toThrow(ValidationError);
    expect(() => validateWeightedPrompts([{ text: " " }])).toThrow(ValidationError);
    expect(() => validateWeightedPrompts([{ text: "a", weight: 0 }])).toThrow(ValidationError);
    expect(() => validateWeightedPrompts([{ text: "a", weight: -2 }])).toThrow(ValidationError);
    expect(() => validateWeightedPrompts([{ text: "a", color: "red" }])).toThrow(ValidationError);
  });

  it("sorts changes and keeps them inside the recording", () => {
    const p = validateSessionPlan(
      plan({
        durationSeconds: 10,
        changes: [
          { at: 8, config: { density: 0.2 } },
          { at: 3, prompts: [{ text: "piano", weight: 1 }] },
        ],
      }),
    );
    expect(p.changes?.map((c) => c.at)).toEqual([3, 8]);
    expect(() => validateSessionPlan(plan({ durationSeconds: 0.5 }))).toThrow(ValidationError);
    expect(() =>
      validateSessionPlan(plan({ changes: [null as unknown as { at: number }] })),
    ).toThrow(/must be an object/);
    expect(() =>
      validateSessionPlan(plan({ changes: [{ at: 1, config: {}, when: 3 } as never] })),
    ).toThrow(/unknown fields: when/);
    expect(() => validateSessionPlan(plan({ durationSeconds: 601 }))).toThrow(ValidationError);
    expect(() =>
      validateSessionPlan(plan({ durationSeconds: 5, changes: [{ at: 5, config: {} }] })),
    ).toThrow(ValidationError);
    expect(() => parsePromptsFile({ prompts: [{ text: "a" }], extra: 1 })).toThrow(ValidationError);
  });

  it("checks the chunk layout against the WAV header", () => {
    expect(() => checkChunkMime("audio/l16;rate=48000;channels=2")).not.toThrow();
    expect(() => checkChunkMime(undefined)).not.toThrow();
    expect(() => checkChunkMime("audio/l16;rate=24000;channels=2")).toThrow(/format/);
    expect(() => checkChunkMime("audio/l16;rate=48000;channels=1")).toThrow(/format/);
  });
});

describe("LyriaRealtimeSession", () => {
  it("sets up, sends prompts, config with a context reset, then PLAY", async () => {
    const t = session(plan({ config: { bpm: 90, density: 0.5 } }));
    const ws = t.ws();
    expect(ws.url).toContain("BidiGenerateMusic?key=rt-key%2F0001");
    ws.open();
    expect(ws.sent).toEqual([{ setup: { model: "models/lyria-realtime-exp" } }]);
    ws.message({ setupComplete: {} });
    expect(ws.sent.slice(1)).toEqual([
      { clientContent: { weightedPrompts: [{ text: "minimal techno", weight: 1 }] } },
      { musicGenerationConfig: { bpm: 90, density: 0.5 } },
      { playbackControl: "RESET_CONTEXT" },
      { playbackControl: "PLAY" },
    ]);
  });

  it("does not reset the context for config that takes effect live", () => {
    const t = session(plan({ config: { density: 0.5 } }));
    t.ws().open();
    t.ws().message({ setupComplete: {} });
    expect(t.ws().sent).not.toContainEqual({ playbackControl: "RESET_CONTEXT" });
  });

  it("trims to the planned length in whole frames, then stops and closes", async () => {
    const t = session(plan({ durationSeconds: 1 }));
    const ws = t.ws();
    ws.open();
    ws.message({ setupComplete: {} });
    ws.audio(ONE_SECOND - 3); // 3 bytes short of a frame boundary: the last partial frame is dropped
    ws.audio(1000);
    const result = await t.promise;
    expect(result).toEqual({ reason: "complete", bytes: ONE_SECOND, seconds: 1 });
    const total = t.audio.reduce((n, c) => n + c.length, 0);
    expect(total).toBe(ONE_SECOND);
    for (const c of t.audio) expect(c.length % 4).toBe(0);
    expect(ws.sent.at(-1)).toEqual({ playbackControl: "STOP" });
    expect(ws.closed?.code).toBe(1000);
  });

  it("applies timed changes once the recording reaches them", async () => {
    const t = session(
      plan({
        durationSeconds: 3,
        changes: [
          {
            at: 1,
            prompts: [{ text: "ambient", weight: 2 }],
            config: { scale: "D_MAJOR_B_MINOR" },
          },
        ],
      }),
    );
    const ws = t.ws();
    ws.open();
    ws.message({ setupComplete: {} });
    ws.audio(ONE_SECOND / 2);
    expect(t.changes).toEqual([]);
    ws.audio(ONE_SECOND / 2);
    expect(t.changes).toEqual([1]);
    expect(ws.sent.slice(-3)).toEqual([
      { clientContent: { weightedPrompts: [{ text: "ambient", weight: 2 }] } },
      { musicGenerationConfig: { scale: "D_MAJOR_B_MINOR" } },
      { playbackControl: "RESET_CONTEXT" },
    ]);
    t.s.stop();
    expect((await t.promise).reason).toBe("stopped");
  });

  it("carries a partial frame into the next chunk instead of dropping it", async () => {
    const t = session(plan({ durationSeconds: 1 }));
    const ws = t.ws();
    ws.open();
    ws.message({ setupComplete: {} });
    const bytes = (from: number, n: number) =>
      Buffer.from(Array.from({ length: n }, (_, i) => (from + i) % 256));
    for (const [from, n] of [
      [0, 6],
      [6, 8],
      [14, 2],
    ] as const) {
      ws.message({ serverContent: { audioChunks: [{ data: bytes(from, n).toString("base64") }] } });
    }
    expect(Buffer.concat(t.audio)).toEqual(bytes(0, 16));
    t.s.stop();
    await t.promise;
  });

  it("sends each timed config merged with the config in effect, resetting only on a bpm or scale change", async () => {
    const t = session(
      plan({
        durationSeconds: 3,
        config: { bpm: 100, muteDrums: true },
        changes: [
          { at: 1, config: { density: 0.2 } },
          { at: 2, config: { bpm: 120 } },
        ],
      }),
    );
    const ws = t.ws();
    ws.open();
    ws.message({ setupComplete: {} });
    ws.audio(ONE_SECOND);
    expect(ws.sent.at(-1)).toEqual({
      musicGenerationConfig: { bpm: 100, muteDrums: true, density: 0.2 },
    });
    ws.audio(ONE_SECOND);
    expect(ws.sent.slice(-2)).toEqual([
      { musicGenerationConfig: { bpm: 120, muteDrums: true, density: 0.2 } },
      { playbackControl: "RESET_CONTEXT" },
    ]);
    t.s.stop();
    await t.promise;
  });

  it("ends a recording as closed when the socket errors after audio arrived", async () => {
    const t = session(plan());
    t.ws().open();
    t.ws().message({ setupComplete: {} });
    t.ws().audio(ONE_SECOND / 2);
    t.ws().emit("error", { message: "connection reset" });
    expect(await t.promise).toMatchObject({ reason: "closed", seconds: 0.5 });
  });

  it("reports filtered prompts", () => {
    const t = session(plan());
    t.ws().open();
    t.ws().message({ filteredPrompt: { text: "a famous artist", filteredReason: "SAFETY" } });
    expect(t.filtered).toEqual(["SAFETY:a famous artist"]);
  });

  it("keeps a recording the server closes early, and fails one that never started", async () => {
    const early = session(plan());
    early.ws().open();
    early.ws().message({ setupComplete: {} });
    early.ws().audio(ONE_SECOND / 2);
    early.ws().emit("close", { code: 1011, reason: "internal" });
    expect(await early.promise).toMatchObject({ reason: "closed", seconds: 0.5 });

    const never = session(plan());
    never.ws().open();
    never.ws().emit("close", { code: 1008, reason: "API key not valid" });
    await expect(never.promise).rejects.toThrow(
      "closed the session (code 1008): API key not valid",
    );
  });

  it("times out a setup that never answers, and ends an idle stream with what it has", async () => {
    const setup = session(plan());
    setup.ws().open();
    setup.timers.fire();
    await expect(setup.promise).rejects.toThrow("setup timed out");
    expect(setup.ws().closed).toBeDefined();

    const idle = session(plan());
    idle.ws().open();
    idle.ws().message({ setupComplete: {} });
    idle.ws().audio(ONE_SECOND / 4);
    idle.timers.fire();
    expect(await idle.promise).toMatchObject({ reason: "closed", seconds: 0.25 });
  });

  it("rejects a chunk whose format does not match the WAV header", async () => {
    const t = session(plan());
    t.ws().open();
    t.ws().message({ setupComplete: {} });
    t.ws().audio(400, "audio/l16;rate=44100;channels=2");
    await expect(t.promise).rejects.toThrow(/Unexpected Lyria RealTime audio format/);
  });

  it("never puts the key in an error message", async () => {
    const key = "secret-key-123";
    const t = session(plan(), key);
    t.ws().emit("error", { message: `connect to wss://x/y?key=${key} failed` });
    const err = (await t.promise.catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain(key);
    expect(err.message).toContain("key=[redacted]");
  });

  it("reads a Blob message as text", async () => {
    const t = session(plan({ durationSeconds: 1 }));
    t.ws().open();
    t.ws().emit("message", { data: new Blob([JSON.stringify({ setupComplete: {} })]) });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.ws().sent).toContainEqual({ playbackControl: "PLAY" });
  });
});

describe("StreamingWavWriter", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-wav-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("writes a valid header with the final sizes", () => {
    const file = path.join(tmp, "a.wav");
    const w = new StreamingWavWriter(file, 48_000, 2, 16);
    w.write(new Uint8Array(400));
    w.write(new Uint8Array(400));
    w.finish();
    w.finish();
    const buf = fs.readFileSync(file);
    expect(buf.length).toBe(44 + 800);
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.readUInt32LE(4)).toBe(36 + 800);
    expect(buf.toString("ascii", 8, 12)).toBe("WAVE");
    expect(buf.readUInt16LE(22)).toBe(2);
    expect(buf.readUInt32LE(24)).toBe(48_000);
    expect(buf.readUInt32LE(28)).toBe(48_000 * 4);
    expect(buf.readUInt16LE(34)).toBe(16);
    expect(buf.readUInt32LE(40)).toBe(800);
  });
});

describe("recordGeminiMusicLive", () => {
  let tmp: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-live-"));
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("GEMINI_API_KEY") || k === "MULTIX_OUTPUT_DIR") {
        saved[k] = process.env[k];
        Reflect.deleteProperty(process.env, k);
      }
    }
    process.env.GEMINI_API_KEY = "live-key-0001";
    process.env.MULTIX_OUTPUT_DIR = path.join(tmp, "out");
    _resetOutputDir();
    _resetGeminiKeyCooldowns();
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
  });

  /** A server that answers setup and streams `chunks` of `bytes` each, asynchronously. */
  function server(chunks: number, bytes: number, closeAfter = false) {
    const sockets: FakeSocket[] = [];
    let sent = 0;
    const factory = (url: string) => {
      const ws = new FakeSocket(url);
      sockets.push(ws);
      const origSend = ws.send.bind(ws);
      ws.send = (data: string) => {
        origSend(data);
        const msg = JSON.parse(data);
        if (msg.setup) setTimeout(() => ws.message({ setupComplete: {} }), 0);
        if (msg.playbackControl === "PLAY") {
          setTimeout(() => {
            for (let i = 0; i < chunks && ws.readyState === 1; i++) {
              ws.audio(bytes);
              sent++;
            }
            if (closeAfter && ws.readyState === 1) ws.emit("close", { code: 1011 });
          }, 0);
        }
      };
      setTimeout(() => ws.open(), 0);
      return ws;
    };
    /** Resolves once the fake server has sent its first audio chunk. */
    const audioSent = async () => {
      const deadline = Date.now() + 2_000;
      while (sent === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    };
    return { factory, sockets, audioSent };
  }

  it("records the planned length to a WAV and copies it to --output", async () => {
    const { factory, sockets } = server(10, ONE_SECOND / 4);
    const output = path.join(tmp, "copy", "live.wav");
    const result = await recordGeminiMusicLive({
      plan: plan({ durationSeconds: 1 }),
      output,
      createWebSocket: factory,
      signals: [],
    });
    expect(result).toMatchObject({ reason: "complete", seconds: 1, output });
    expect(sockets[0]?.url).toContain("key=live-key-0001");
    const buf = fs.readFileSync(result.generatedAudio);
    expect(buf.length).toBe(44 + ONE_SECOND);
    expect(buf.readUInt32LE(40)).toBe(ONE_SECOND);
    expect(fs.readFileSync(output)).toEqual(buf);
  });

  it("keeps a finalised partial recording when the server closes early", async () => {
    const { factory } = server(2, ONE_SECOND / 4, true);
    const result = await recordGeminiMusicLive({
      plan: plan({ durationSeconds: 2 }),
      createWebSocket: factory,
      signals: [],
    });
    expect(result).toMatchObject({ reason: "closed", seconds: 0.5 });
    const buf = fs.readFileSync(result.generatedAudio);
    expect(buf.readUInt32LE(40)).toBe(ONE_SECOND / 2);
  });

  it("removes the empty file when the session fails before any audio", async () => {
    const factory = (url: string) => {
      const ws = new FakeSocket(url);
      setTimeout(() => {
        ws.open();
        ws.emit("close", { code: 1008, reason: "denied" });
      }, 0);
      return ws;
    };
    await expect(
      recordGeminiMusicLive({ plan: plan(), createWebSocket: factory, signals: [] }),
    ).rejects.toThrow(/code 1008/);
    const out = path.join(tmp, "out");
    expect(fs.existsSync(out) ? fs.readdirSync(out) : []).toEqual([]);
  });

  it("on a signal finalises the WAV, copies it to --output and exits through the runtime", async () => {
    const { factory, audioSent } = server(1, ONE_SECOND / 4);
    const before = process.listenerCount("SIGINT");
    const exits: number[] = [];
    const output = path.join(tmp, "copy", "live.wav");
    run.interrupted = undefined;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const pending = recordGeminiMusicLive({
        plan: plan({ durationSeconds: 5 }),
        output,
        createWebSocket: factory,
        signals: ["SIGINT"],
        exit: (code) => exits.push(code),
      });
      // A fixed delay races the fake session's timers (coarse on Windows): wait for the audio.
      await audioSent();
      expect(process.listenerCount("SIGINT")).toBe(before + 1);
      process.emit("SIGINT", "SIGINT");
      expect(exits).toEqual([130]);
      expect(process.listenerCount("SIGINT")).toBe(before);
      // The copy is made before the process would exit.
      expect(fs.readFileSync(output).readUInt32LE(40)).toBe(ONE_SECOND / 4);
      expect(run.interrupted).toMatchObject({ retryable: false });
      const result = await pending;
      expect(result.reason).toBe("stopped");
    } finally {
      stderr.mockRestore();
      run.interrupted = undefined;
    }
  });
});

describe("planFromFlags", () => {
  const base = { prompt: [] as string[], weight: [] as string[], duration: "30" };
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-plan-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("pairs prompts with weights and collects the config flags", () => {
    expect(
      planFromFlags({
        ...base,
        prompt: ["jazz", "rain"],
        weight: ["2", "0.5"],
        duration: "12",
        bpm: "100",
        muteDrums: true,
      }),
    ).toEqual({
      prompts: [
        { text: "jazz", weight: 2 },
        { text: "rain", weight: 0.5 },
      ],
      config: { bpm: 100, muteDrums: true },
      changes: [],
      durationSeconds: 12,
    });
  });

  it("merges flag config over the prompts file config", () => {
    const file = path.join(tmp, "p.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        prompts: [{ text: "lofi" }],
        config: { bpm: 80, density: 0.3 },
        changes: [{ at: 5, config: { density: 0.8 } }],
      }),
    );
    const p = planFromFlags({ ...base, promptsFile: file, bpm: "95" });
    expect(p.config).toEqual({ bpm: 95, density: 0.3 });
    expect(p.changes).toHaveLength(1);
  });

  it("rejects ambiguous or malformed input", () => {
    expect(() => planFromFlags(base)).toThrow(/--prompt or --prompts-file/);
    expect(() => planFromFlags({ ...base, prompt: ["a", "b"], weight: ["1"] })).toThrow(
      /one --weight per --prompt/,
    );
    expect(() => planFromFlags({ ...base, prompt: ["a"], bpm: "fast" })).toThrow(/--bpm/);
    expect(() => planFromFlags({ ...base, prompt: ["a"], duration: "0" })).toThrow(ValidationError);
    const file = path.join(tmp, "bad.json");
    fs.writeFileSync(file, "{not json");
    expect(() => planFromFlags({ ...base, promptsFile: file })).toThrow(/not valid JSON/);
    expect(() => planFromFlags({ ...base, promptsFile: file, prompt: ["a"] })).toThrow(
      /Pass the prompts once/,
    );
  });
});
