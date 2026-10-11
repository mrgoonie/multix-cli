/**
 * Provider model defaults set only in a `.env` file must reach the request.
 * The provider modules are imported (and evaluated) before the `.env` file
 * exists and before loadEnv() runs, the same order as `dist/cli.js`, so a
 * default captured at module load would miss the file value.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetEnvLoader, loadEnv } from "../../../src/core/env-loader.js";
import { _resetOutputDir } from "../../../src/core/output-dir.js";
import { registerBytePlusCommands } from "../../../src/providers/byteplus/commands/index.js";
import { registerFalCommands } from "../../../src/providers/fal/commands/index.js";
import { registerLeonardoCommands } from "../../../src/providers/leonardo/commands/index.js";
import { registerMinimaxCommands } from "../../../src/providers/minimax/commands/index.js";

const MANAGED = [
  "LEONARDO_API_KEY",
  "LEONARDO_DEFAULT_MODEL",
  "LEONARDO_VIDEO_MODEL",
  "LEONARDO_BASE_URL",
  "MINIMAX_API_KEY",
  "MINIMAX_IMAGE_MODEL",
  "MINIMAX_VIDEO_MODEL",
  "MINIMAX_SPEECH_MODEL",
  "MINIMAX_MUSIC_MODEL",
  "MINIMAX_BASE_URL",
  "FAL_KEY",
  "FAL_IMAGE_MODEL",
  "FAL_VIDEO_MODEL",
  "FAL_VIDEO_IMAGE_MODEL",
  "FAL_BASE_URL",
  "BYTEPLUS_API_KEY",
  "ARK_API_KEY",
  "BYTEPLUS_IMAGE_MODEL",
  "BYTEPLUS_VIDEO_MODEL",
  "BYTEPLUS_3D_MODEL",
  "BYTEPLUS_BASE_URL",
  "MULTIX_OUTPUT_DIR",
];

interface Call {
  url: string;
  body: Record<string, unknown> | undefined;
}

let tmp: string;
let saved: Record<string, string | undefined>;
let calls: Call[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-env-model-"));
  saved = Object.fromEntries(MANAGED.map((name) => [name, process.env[name]]));
  for (const name of MANAGED) delete process.env[name];
  // Keys come from the shell; only the model defaults live in the .env file.
  process.env.LEONARDO_API_KEY = "test-leonardo-key";
  process.env.MINIMAX_API_KEY = "test-minimax-key";
  process.env.FAL_KEY = "test-fal-key";
  process.env.BYTEPLUS_API_KEY = "test-byteplus-key";
  process.env.MULTIX_OUTPUT_DIR = path.join(tmp, "out");
  vi.spyOn(process, "cwd").mockReturnValue(tmp);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
  calls = [];
  // Record the request, then fail it so the command stops after one call.
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    return new Response(JSON.stringify({ error: "stop" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  });
  _resetEnvLoader();
  _resetOutputDir();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const name of MANAGED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  _resetEnvLoader();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write the project `.env`, load it like the CLI does, then run one command. */
async function runWithEnvFile(envFile: string, args: string[]): Promise<Call> {
  fs.writeFileSync(path.join(tmp, ".env"), envFile);
  loadEnv();
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerLeonardoCommands(program);
  registerMinimaxCommands(program);
  registerFalCommands(program);
  registerBytePlusCommands(program);
  await program.parseAsync(["node", "multix", ...args]).catch(() => {});
  const first = calls[0];
  if (!first) throw new Error("command sent no request");
  return first;
}

describe("model defaults from a .env file", () => {
  it("leonardo generate uses LEONARDO_DEFAULT_MODEL", async () => {
    const call = await runWithEnvFile("LEONARDO_DEFAULT_MODEL=file-leonardo-model\n", [
      "leonardo",
      "generate",
      "a cat",
    ]);
    expect(call.body?.modelId).toBe("file-leonardo-model");
  });

  it("leonardo video uses LEONARDO_VIDEO_MODEL", async () => {
    const call = await runWithEnvFile("LEONARDO_VIDEO_MODEL=VEO3\n", [
      "leonardo",
      "video",
      "a cat",
    ]);
    expect(JSON.stringify(call.body)).toContain('"VEO3"');
  });

  it("minimax generate uses MINIMAX_IMAGE_MODEL", async () => {
    const call = await runWithEnvFile("MINIMAX_IMAGE_MODEL=image-01-live\n", [
      "minimax",
      "generate",
      "--prompt",
      "a cat",
    ]);
    expect(call.body?.model).toBe("image-01-live");
  });

  it("minimax generate-speech uses MINIMAX_SPEECH_MODEL", async () => {
    const call = await runWithEnvFile("MINIMAX_SPEECH_MODEL=speech-02-turbo\n", [
      "minimax",
      "generate-speech",
      "--text",
      "hello",
    ]);
    expect(call.body?.model).toBe("speech-02-turbo");
  });

  it("fal image uses FAL_IMAGE_MODEL in the queue URL", async () => {
    const call = await runWithEnvFile("FAL_IMAGE_MODEL=fal-ai/file-image-model\n", [
      "fal",
      "image",
      "a cat",
    ]);
    expect(call.url).toContain("/fal-ai/file-image-model");
  });

  it("fal video uses FAL_VIDEO_MODEL and FAL_VIDEO_IMAGE_MODEL", async () => {
    const env = "FAL_VIDEO_MODEL=fal-ai/file-t2v\nFAL_VIDEO_IMAGE_MODEL=fal-ai/file-i2v\n";
    const t2v = await runWithEnvFile(env, ["fal", "video", "a cat"]);
    expect(t2v.url).toContain("/fal-ai/file-t2v");
    calls = [];
    const i2v = await runWithEnvFile(env, [
      "fal",
      "video",
      "a cat",
      "--image-url",
      "https://example.com/cat.png",
    ]);
    expect(i2v.url).toContain("/fal-ai/file-i2v");
  });

  it("byteplus generate uses BYTEPLUS_IMAGE_MODEL", async () => {
    const call = await runWithEnvFile("BYTEPLUS_IMAGE_MODEL=file-seedream\n", [
      "byteplus",
      "generate",
      "--prompt",
      "a cat",
    ]);
    expect(call.body?.model).toBe("file-seedream");
  });

  it("byteplus video uses BYTEPLUS_VIDEO_MODEL as the --model default", async () => {
    const call = await runWithEnvFile("BYTEPLUS_VIDEO_MODEL=seedance-2.0-fast\n", [
      "byteplus",
      "video",
      "--prompt",
      "a cat",
    ]);
    expect(call.body?.model).toBe("seedance-2.0-fast");
  });

  it("byteplus generate-3d uses BYTEPLUS_3D_MODEL as the --model default", async () => {
    const call = await runWithEnvFile("BYTEPLUS_3D_MODEL=file-3d-model\n", [
      "byteplus",
      "generate-3d",
      "--prompt",
      "a cat",
    ]);
    expect(call.body?.model).toBe("file-3d-model");
  });

  it("a shell value still wins over the .env file", async () => {
    process.env.FAL_IMAGE_MODEL = "fal-ai/shell-model";
    const call = await runWithEnvFile("FAL_IMAGE_MODEL=fal-ai/file-model\n", [
      "fal",
      "image",
      "a cat",
    ]);
    expect(call.url).toContain("/fal-ai/shell-model");
  });

  it("a blank .env value falls back to the built-in default", async () => {
    const call = await runWithEnvFile("MINIMAX_IMAGE_MODEL=\n", [
      "minimax",
      "generate",
      "--prompt",
      "a cat",
    ]);
    expect(call.body?.model).toBe("image-01");
  });
});
