/**
 * `multix fish voice-design` and `fish voices create|update|delete` driven
 * through commander with global fetch stubbed: the voice-design header and
 * saved WAV candidates with their estimate, the clone multipart fields and the
 * checks that run before anything is sent (consent, public visibility, sample
 * files), and the --yes confirmations. No network.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run as runState } from "../../../../src/agent/run-state.js";
import { estimateCommand } from "../../../../src/budget/command-cost.js";
import { buildCostReceipt } from "../../../../src/budget/cost-receipt.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerFishCommands } from "../../../../src/providers/fish/commands/index.js";

const KEY = "fish-SECRET_KEY_VALUE";
const VOICE = "aaaabbbbccccddddeeeeffff00001111";

/** 16-bit mono PCM WAV of `samples` silent samples. */
function wav(rate = 24_000, samples = 2400): Uint8Array {
  const data = samples * 2;
  const buf = new Uint8Array(44 + data);
  const view = new DataView(buf.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, data, true);
  return buf;
}
const WAV = wav();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

interface Call {
  method: string;
  url: string;
  headers: Headers;
  body?: unknown;
}

let tmp: string;
let output: string[];
let stdout: string[];
let calls: Call[];

function stubFetch(respond: (url: string, method: string) => Response) {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body =
      init?.body instanceof FormData
        ? init.body
        : init?.body
          ? JSON.parse(String(init.body))
          : undefined;
    calls.push({ method, url, headers: new Headers(init?.headers), body });
    return respond(url, method);
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const MODEL = {
  _id: VOICE,
  title: "Narrator",
  type: "tts",
  state: "trained",
  visibility: "private",
  train_mode: "fast",
  languages: ["en"],
  tags: [],
  created_at: "2026-10-27T00:00:00Z",
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-fish-voices-"));
  vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(tmp, "out"));
  vi.stubEnv("FISH_API_KEY", KEY);
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
  runState.requestModel = undefined;
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

function sample(name: string, bytes: Uint8Array = WAV): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, bytes);
  return file;
}

describe("fish voice-design", () => {
  it("posts once with the voice-design-1 header, saves each candidate as WAV and prices it", async () => {
    stubFetch(() =>
      json({
        candidates: [
          { id: "c0", index: 0, audio_base64: b64(WAV), sample_rate: 24000, duration_ms: 100 },
          { id: "c1", index: 1, audio_base64: b64(WAV), sample_rate: 24000, duration_ms: 100 },
        ],
      }),
    );
    runState.json = true;
    await run("voice-design", "--instruction", "Warm narrator", "--count", "2", "--seed", "7");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.fish.audio/v1/voice-design");
    expect(calls[0]?.headers.get("model")).toBe("voice-design-1");
    expect(calls[0]?.body).toEqual({ instruction: "Warm narrator", n: 2, seed: 7 });
    expect(runState.requestModel).toBe("voice-design-1");
    const result = jsonResult();
    expect(result).toMatchObject({
      provider: "fish",
      model_header_sent: "voice-design-1",
      candidates_requested: 2,
      estimated_cost_usd: 0.01,
      rate_id: "fish/voice-design-1@api",
      warnings: [],
    });
    expect(result.candidates).toHaveLength(2);
    for (const c of result.candidates) {
      expect(c.signature_ok).toBe(true);
      expect(c.sample_rate_hz).toBe(24000);
      expect(c.duration_s).toBe(0.1);
      expect(path.basename(c.path)).toMatch(/^fish_voice_design_.+_[12]\.wav$/);
      expect([...fs.readFileSync(c.path)]).toEqual([...WAV]);
    }
    expect(allText()).not.toContain(KEY);
  });

  it("fails without sending when the description is missing or a value is out of range", async () => {
    stubFetch(() => json({}));
    await expect(run("voice-design")).rejects.toThrow("--instruction");
    await expect(run("voice-design", "--instruction", "x", "--count", "5")).rejects.toThrow(
      "--count",
    );
    await expect(run("voice-design", "--instruction", "x", "--speed", "fast")).rejects.toThrow(
      "--speed must be a number",
    );
    expect(calls).toHaveLength(0);
  });

  it("fails, after saving it, when no candidate is a WAV file", async () => {
    stubFetch(() =>
      json({
        candidates: [
          {
            id: "c0",
            index: 0,
            audio_base64: b64(new TextEncoder().encode("<html>")),
            sample_rate: 1,
            duration_ms: 1,
          },
        ],
      }),
    );
    await expect(run("voice-design", "--instruction", "x")).rejects.toThrow(
      /no usable WAV candidate.*still billed/,
    );
  });

  it("asks Fish for 2 candidates when --count is omitted, so caps see the real count", async () => {
    stubFetch(() =>
      json({ candidates: [{ id: "c0", index: 5, audio_base64: b64(WAV), sample_rate: 24000 }] }),
    );
    await run("voice-design", "--instruction", "x");
    expect(calls[0]?.body).toEqual({ instruction: "x", n: 2 });
    expect(allText()).toContain("Candidate 1: ");
    expect(allText()).toMatch(/fish_voice_design_.+_1\.wav/);
  });

  it("settles a successful run's receipt at $0.01", () => {
    const receipt = buildCostReceipt({
      operation_id: "op",
      outcome: "ok",
      provider: "fish",
      model: "voice-design-1",
      calls: [{ method: "POST", status: 200 }],
    });
    expect(receipt).toMatchObject({ status: "computed", actual_usd: 0.01 });
  });

  it("is priced at $0.01 per request before it runs, whatever the candidate count", () => {
    const estimate = estimateCommand("fish voice-design", { instruction: "x", count: "4" });
    expect(estimate).toMatchObject({
      status: "estimated",
      expected_usd: 0.01,
      high_usd: 0.01,
      upper_bound: "proven",
    });
  });
});

describe("fish voices create", () => {
  it("sends the multipart clone request with every field once", async () => {
    stubFetch(() => json(MODEL, 201));
    runState.json = true;
    const a = sample("a.wav");
    const b = sample("b.wav");
    await run(
      "voices",
      "create",
      "--title",
      "Narrator",
      "--sample",
      a,
      "--sample",
      b,
      "--transcript",
      "One.",
      "--transcript",
      "Two.",
      "--tag",
      "calm",
      "--visibility",
      "unlist",
      "--no-enhance-audio-quality",
      "--voice-design-signature",
      "s1",
      "--voice-design-signature",
      "s2",
      "--consent",
    );
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://api.fish.audio/model");
    expect(call?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    const form = call?.body as FormData;
    expect(form.get("type")).toBe("tts");
    expect(form.get("train_mode")).toBe("fast");
    expect(form.get("title")).toBe("Narrator");
    expect(form.get("visibility")).toBe("unlist");
    expect(form.getAll("texts")).toEqual(["One.", "Two."]);
    expect(form.getAll("tags")).toEqual(["calm"]);
    expect(form.getAll("voice_design_signatures")).toEqual(["s1", "s2"]);
    expect(form.get("enhance_audio_quality")).toBe("false");
    expect(form.get("generate_sample")).toBeNull();
    const voices = form.getAll("voices") as File[];
    expect(voices.map((f) => f.name)).toEqual(["a.wav", "b.wav"]);
    expect(voices[0]?.type).toBe("audio/wav");
    expect(new Uint8Array((await voices[0]?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(WAV);
    expect(jsonResult()).toMatchObject({ id: VOICE, state: "trained", samples: 2, warnings: [] });
  });

  it("types a sample with no extension by its bytes", async () => {
    stubFetch(() => json(MODEL, 201));
    await run("voices", "create", "--title", "N", "--sample", sample("download"), "--consent");
    const file = (calls[0]?.body as FormData).get("voices") as File;
    expect(file.name).toBe("download.wav");
    expect(file.type).toBe("audio/wav");
  });

  it("warns when the new model is not trained yet", async () => {
    stubFetch(() => json({ ...MODEL, state: "training" }, 201));
    await run("voices", "create", "--title", "N", "--sample", sample("a.wav"), "--consent");
    expect(allText()).toContain("voice state is training");
  });

  it.each([
    [["--title", "N"], "--consent"],
    [["--title", "N", "--consent", "--visibility", "public"], "--visibility public"],
    [["--consent"], "--title"],
    [["--title", "N", "--consent", "--transcript", "a", "--transcript", "b"], "one --transcript"],
  ])("refuses %j before sending anything", async (extra, message) => {
    stubFetch(() => json(MODEL, 201));
    await expect(run("voices", "create", "--sample", sample("a.wav"), ...extra)).rejects.toThrow(
      message,
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses missing, mislabelled or unsupported sample files", async () => {
    stubFetch(() => json(MODEL, 201));
    const base = ["voices", "create", "--title", "N", "--consent", "--sample"];
    await expect(run(...base, path.join(tmp, "nope.wav"))).rejects.toThrow("not found");
    await expect(run(...base, sample("fake.mp3"))).rejects.toThrow("its bytes are wav");
    await expect(run(...base, sample("x.flac"))).rejects.toThrow("Fish takes");
    await expect(run(...base, sample("noext", new Uint8Array([1, 2, 3])))).rejects.toThrow(
      "has no extension",
    );
    await expect(run("voices", "create", "--title", "N", "--consent")).rejects.toThrow(
      "1 to 20 --sample",
    );
    expect(calls).toHaveLength(0);
  });

  it("reports a gateway error as unknown and points at the voice list", async () => {
    stubFetch(() => new Response("<html>504</html>", { status: 504 }));
    await expect(
      run("voices", "create", "--title", "N", "--sample", sample("a.wav"), "--consent"),
    ).rejects.toThrow(/may have created a voice model.*fish voices list/);
    expect(calls).toHaveLength(1);
  });
});

describe("fish voices update and delete", () => {
  it("patches the metadata and reads the model back", async () => {
    stubFetch((_url, method) => (method === "PATCH" ? new Response(null) : json(MODEL)));
    runState.json = true;
    await run("voices", "update", VOICE, "--title", "New", "--tag", "a", "--tag", "b");
    expect(calls.map((c) => c.method)).toEqual(["PATCH", "GET"]);
    expect(calls[0]?.url).toBe(`https://api.fish.audio/model/${VOICE}`);
    expect(calls[0]?.body).toEqual({ title: "New", tags: ["a", "b"] });
    expect(jsonResult()).toMatchObject({ id: VOICE });
  });

  it("needs --yes to make a voice public, and something to change", async () => {
    stubFetch(() => json(MODEL));
    await expect(run("voices", "update", VOICE, "--visibility", "public")).rejects.toThrow("--yes");
    await expect(run("voices", "update", VOICE)).rejects.toThrow("Nothing to change");
    expect(calls).toHaveLength(0);
    await run("voices", "update", VOICE, "--visibility", "public", "--yes");
    expect(calls[0]?.body).toEqual({ visibility: "public" });
  });

  it("deletes only with --yes", async () => {
    stubFetch(() => new Response(null));
    await expect(run("voices", "delete", VOICE)).rejects.toThrow("--yes");
    expect(calls).toHaveLength(0);
    await expect(run("voices", "delete", "../x", "--yes")).rejects.toThrow(
      "not a Fish Audio voice id",
    );
    runState.json = true;
    await run("voices", "delete", VOICE, "--yes");
    expect(calls).toEqual([
      expect.objectContaining({ method: "DELETE", url: `https://api.fish.audio/model/${VOICE}` }),
    ]);
    expect(jsonResult()).toEqual({ id: VOICE, deleted: true });
  });
});
