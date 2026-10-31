import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderJobFailedError, ValidationError } from "../../../../src/core/errors.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerGeminiGenerateMusicCommands } from "../../../../src/providers/gemini/commands/generate-music.js";
import { _resetGeminiKeyCooldowns } from "../../../../src/providers/gemini/key-pool.js";

const API = "https://generativelanguage.googleapis.com/v1beta";
const ID = "v1_song1";
const MP3 = Buffer.from("ID3\u0003\u0000\u0000fake-mp3");

let tmp: string;
let stdout: string[];
let gets: number;
let posts: number;
const savedEnv: Record<string, string | undefined> = {};

function stubInteraction(body: Record<string, unknown>): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if ((init.method ?? "GET") !== "GET" || url !== `${API}/interactions/${ID}`) {
      posts++;
      throw new Error(`unexpected ${init.method} ${url}`);
    }
    gets++;
    return new Response(JSON.stringify({ id: ID, ...body }), { status: 200 });
  });
}

const completed = (model = "lyria-3-clip-preview") => ({
  status: "completed",
  model,
  steps: [
    {
      type: "model_output",
      content: [
        { type: "text", text: "[Verse] la la" },
        { type: "audio", data: MP3.toString("base64") },
      ],
    },
  ],
});

function program(): Command {
  const root = new Command();
  root.exitOverride();
  registerGeminiGenerateMusicCommands(root);
  return root;
}

const runStatus = (...args: string[]) =>
  program().parseAsync(["node", "multix", "music-status", ID, ...args]);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-music-status-"));
  stdout = [];
  gets = 0;
  posts = 0;
  _resetGeminiKeyCooldowns();
  _resetOutputDir();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GEMINI_API_KEY") || k === "MULTIX_OUTPUT_DIR") {
      savedEnv[k] = process.env[k];
      Reflect.deleteProperty(process.env, k);
    }
  }
  process.env.GEMINI_API_KEY = "test-key-1";
  process.env.MULTIX_OUTPUT_DIR = tmp;
  vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    stdout.push(String(msg));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe("gemini music-status", () => {
  it("prints a summary without audio bytes", async () => {
    stubInteraction(completed());
    await runStatus();
    const summary = JSON.parse(stdout.join("\n"));
    expect(summary).toMatchObject({ interaction_id: ID, status: "completed" });
    expect(stdout.join("\n")).not.toContain(MP3.toString("base64"));
  });

  it("downloads a completed song and its lyrics, copying to --output, with GETs only", async () => {
    stubInteraction(completed("models/lyria-3.5"));
    const output = path.join(tmp, "copy", "song.mp3");
    await runStatus("--download", "--output", output);
    const dest = stdout.at(-1) ?? "";
    expect(dest).toMatch(/gemini_lyria_.*\.mp3$/);
    expect(fs.readFileSync(dest)).toEqual(MP3);
    expect(fs.readFileSync(output)).toEqual(MP3);
    expect(fs.readFileSync(dest.replace(/\.mp3$/, ".lyrics.txt"), "utf8")).toBe("[Verse] la la\n");
    expect(posts).toBe(0);
  });

  it("refuses an interaction of another model", async () => {
    stubInteraction({ ...completed(), model: "gemini-omni-flash" });
    await expect(runStatus("--download")).rejects.toThrow(ValidationError);
  });

  it("fails on a failed song", async () => {
    stubInteraction({ status: "failed", model: "lyria-3.5", error: { message: "blocked" } });
    await expect(runStatus()).rejects.toThrow(ProviderJobFailedError);
    expect(gets).toBe(1);
  });
});

describe("gemini generate-music flags", () => {
  it("refuses --output with --no-wait before any request", async () => {
    stubInteraction(completed());
    await expect(
      program().parseAsync([
        "node",
        "multix",
        "generate-music",
        "--prompt",
        "jazz",
        "--no-wait",
        "--output",
        "a.mp3",
      ]),
    ).rejects.toThrow(/music-status/);
    expect(gets + posts).toBe(0);
  });
});
