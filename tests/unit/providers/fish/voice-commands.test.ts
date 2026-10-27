/**
 * `multix fish voice-design`, `fish clone` and `fish voices delete` driven
 * through commander with global fetch stubbed: one request each, the
 * voice-design model header, the billed request recorded for the receipt,
 * consent and --yes gates that send nothing, and the clone multipart form.
 * No network.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run as runState } from "../../../../src/agent/run-state.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerFishCommands } from "../../../../src/providers/fish/commands/index.js";

const KEY = "fish-SECRET_KEY_VALUE";
const VOICE = "c".repeat(32);

function wav(sampleRate: number, dataBytes: number): Uint8Array {
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return out;
}
const wavBase64 = (rate: number, bytes: number) => Buffer.from(wav(rate, bytes)).toString("base64");

interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}

let tmp: string;
let output: string[];
let stdout: string[];
let calls: Call[];

function stubFetch(respond: () => Response) {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    return respond();
  });
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-fish-voice-"));
  vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(tmp, "out"));
  vi.stubEnv("FISH_API_KEY", KEY);
  vi.stubEnv("MULTIX_MAX_DOWNLOAD_MB", "");
  vi.stubEnv("NO_COLOR", "1");
  _resetOutputDir();
  output = [];
  stdout = [];
  calls = [];
  runState.postUsage = [];
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
  runState.data = undefined;
  runState.postUsage = [];
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

const jsonResult = () => JSON.parse(stdout.find((l) => l.startsWith("{")) ?? "{}");

describe("fish voice-design", () => {
  it("posts once with the voice-design-1 header, saves each WAV candidate and records the charge", async () => {
    stubFetch(() =>
      json({
        candidates: [
          { id: "c-1", audio_base64: wavBase64(44_100, 88_200), sample_rate: 44_100 },
          { id: "c-2", audio_base64: wavBase64(44_100, 44_100), sample_rate: 44_100 },
        ],
      }),
    );
    runState.json = true;
    await run("voice-design", "A calm Vietnamese narrator", "--count", "2", "--seed", "7");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.fish.audio/v1/voice-design");
    expect(calls[0]?.headers.get("model")).toBe("voice-design-1");
    expect(calls[0]?.body).toEqual({ instruction: "A calm Vietnamese narrator", n: 2, seed: 7 });
    const result = jsonResult();
    expect(result).toMatchObject({
      model_header_sent: "voice-design-1",
      price_usd_per_request: 0.01,
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({ index: 0, audio_kind: "wav", duration_s: 1 });
    expect(path.basename(result.candidates[1].path)).toMatch(/^fish_voice_design_.*_1\.wav$/);
    expect(fs.existsSync(result.candidates[1].path)).toBe(true);
    expect(runState.postUsage.map((u) => u.metrics)).toEqual([{ "request.count": 1 }]);
    expect(output.join("\n")).not.toContain(KEY);
  });

  it("records the billed request even when the answer is unusable", async () => {
    stubFetch(() => json({ candidates: [] }));
    await expect(run("voice-design", "A calm narrator")).rejects.toThrow(/no candidates/);
    expect(runState.postUsage.map((u) => u.metrics)).toEqual([{ "request.count": 1 }]);
  });

  it("refuses a bad --count or a doubled prompt before sending", async () => {
    stubFetch(() => json({}));
    await expect(run("voice-design", "x", "--count", "5")).rejects.toThrow(/1 to 4/);
    await expect(run("voice-design", "x", "--instruction", "y")).rejects.toThrow(/once/);
    expect(calls).toHaveLength(0);
  });
});

describe("fish clone", () => {
  const sampleFile = (name = "s.wav") => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, wav(16_000, 32));
    return file;
  };

  it("needs --consent and sends nothing without it", async () => {
    stubFetch(() => json({}));
    await expect(run("clone", "--title", "Me", "--sample", sampleFile())).rejects.toThrow(
      /--consent/,
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses a missing, unsupported or mismatched sample before sending", async () => {
    stubFetch(() => json({}));
    await expect(
      run("clone", "--title", "Me", "--sample", path.join(tmp, "nope.wav"), "--consent"),
    ).rejects.toThrow(/not found/);
    await expect(
      run("clone", "--title", "Me", "--sample", sampleFile("s.txt"), "--consent"),
    ).rejects.toThrow(/Fish takes/);
    await expect(
      run(
        "clone",
        "--title",
        "Me",
        "--sample",
        sampleFile(),
        "--transcript",
        "a",
        "--transcript",
        "b",
        "--consent",
      ),
    ).rejects.toThrow(/one transcript per sample/);
    expect(calls).toHaveLength(0);
  });

  it("uploads a private fast clone as multipart, once", async () => {
    stubFetch(() =>
      json({ _id: VOICE, title: "Me", state: "trained", visibility: "private" }, 201),
    );
    runState.json = true;
    await run(
      "clone",
      "--title",
      "Me",
      "--sample",
      sampleFile(),
      "--transcript",
      "Xin chào",
      "--consent",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://api.fish.audio/model" });
    const form = calls[0]?.body as FormData;
    expect(form.get("type")).toBe("tts");
    expect(form.get("train_mode")).toBe("fast");
    expect(form.get("visibility")).toBe("private");
    expect(form.getAll("texts")).toEqual(["Xin chào"]);
    expect((form.get("voices") as File).name).toBe("s.wav");
    expect(jsonResult()).toMatchObject({ id: VOICE, state: "trained" });
  });
});

describe("fish voices delete", () => {
  it("deletes only with --yes", async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    await expect(run("voices", "delete", VOICE)).rejects.toThrow(/--yes/);
    expect(calls).toHaveLength(0);
    runState.json = true;
    await run("voices", "delete", VOICE, "--yes");
    expect(calls).toMatchObject([
      { method: "DELETE", url: `https://api.fish.audio/model/${VOICE}` },
    ]);
    expect(jsonResult()).toEqual({ deleted: VOICE });
  });
});
