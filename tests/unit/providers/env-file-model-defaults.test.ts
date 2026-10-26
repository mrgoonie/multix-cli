/**
 * Provider model defaults set only in a `.env` file must reach the request.
 * The provider modules are imported (and evaluated) before the `.env` file
 * exists and before loadEnv() runs (with the real project-env allowlist),
 * the same order as `dist/cli.js`, so a
 * default captured at module load would miss the file value.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetEnvLoader, envFileOrigin, loadEnv } from "../../../src/core/env-loader.js";
import { _resetOutputDir } from "../../../src/core/output-dir.js";
import { isProjectEnvName } from "../../../src/project-env-names.js";
import { registerBytePlusCommands } from "../../../src/providers/byteplus/commands/index.js";
import { registerFalCommands } from "../../../src/providers/fal/commands/index.js";
import { registerGeminiCommands } from "../../../src/providers/gemini/commands/index.js";
import {
  ANALYSIS_MODEL_DEFAULT,
  IMAGE_MODEL_DEFAULT,
  TTS_MODEL_DEFAULT,
  VIDEO_MODEL_DEFAULT,
  getDefaultModel,
} from "../../../src/providers/gemini/models.js";
import { registerLeonardoCommands } from "../../../src/providers/leonardo/commands/index.js";
import { registerMinimaxCommands } from "../../../src/providers/minimax/commands/index.js";
import { registerOpenAICommands } from "../../../src/providers/openai/commands/index.js";
import {
  DEFAULT_OPENAI_IMAGE_MODEL,
  DEFAULT_OPENAI_STT_MODEL,
  DEFAULT_OPENAI_TTS_MODEL,
} from "../../../src/providers/openai/models.js";
import { DEFAULT_OPENROUTER_MODEL } from "../../../src/providers/openrouter/client.js";
import { registerOpenRouterCommands } from "../../../src/providers/openrouter/commands/index.js";

const GEMINI_MODEL_ENVS = [
  "IMAGE_GEN_MODEL",
  "GEMINI_IMAGE_GEN_MODEL",
  "VIDEO_GEN_MODEL",
  "GEMINI_TTS_MODEL",
  "TTS_MODEL",
  "MULTIMODAL_MODEL",
  "GEMINI_MODEL",
];

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
  "FAL_TTS_MODEL",
  "FAL_BASE_URL",
  "BYTEPLUS_API_KEY",
  "ARK_API_KEY",
  "BYTEPLUS_IMAGE_MODEL",
  "BYTEPLUS_VIDEO_MODEL",
  "BYTEPLUS_3D_MODEL",
  "BYTEPLUS_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_TTS_MODEL",
  "OPENAI_STT_MODEL",
  "OPENAI_IMAGE_MODEL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_IMAGE_MODEL",
  "OPENROUTER_VIDEO_MODEL",
  "OPENROUTER_FALLBACK_MODELS",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  ...GEMINI_MODEL_ENVS,
  "MULTIX_OUTPUT_DIR",
  "MULTIX_DISABLE_HOME_ENV",
];

interface Call {
  url: string;
  body: Record<string, unknown> | undefined;
  headers: Headers;
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
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  process.env.MULTIX_DISABLE_HOME_ENV = "1";
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
    const raw = init?.body;
    const body =
      typeof raw === "string"
        ? JSON.parse(raw)
        : raw instanceof FormData
          ? Object.fromEntries([...raw.entries()].filter(([, v]) => typeof v === "string"))
          : undefined;
    calls.push({ url, body, headers: new Headers(init?.headers) });
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
  loadEnv({ isProjectEnvName });
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerLeonardoCommands(program);
  registerMinimaxCommands(program);
  registerFalCommands(program);
  registerBytePlusCommands(program);
  registerOpenAICommands(program);
  registerGeminiCommands(program);
  registerOpenRouterCommands(program);
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

  it("fal tts uses FAL_TTS_MODEL in the queue URL", async () => {
    const call = await runWithEnvFile("FAL_TTS_MODEL=elevenlabs/tts/eleven-v4-turbo\n", [
      "fal",
      "tts",
      "hello",
    ]);
    expect(call.url).toContain("/elevenlabs/tts/eleven-v4-turbo");
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

describe("blank model overrides in a .env file (as in a copied .env.example)", () => {
  it("openai generate-speech falls back to the built-in TTS model", async () => {
    const call = await runWithEnvFile("OPENAI_TTS_MODEL=\n", [
      "openai",
      "generate-speech",
      "--text",
      "hello",
    ]);
    expect(call.body?.model).toBe(DEFAULT_OPENAI_TTS_MODEL);
  });

  it("openai generate-speech still uses a non-blank .env value", async () => {
    const call = await runWithEnvFile("OPENAI_TTS_MODEL=tts-1\n", [
      "openai",
      "generate-speech",
      "--text",
      "hello",
    ]);
    expect(call.body?.model).toBe("tts-1");
  });

  it("openai transcribe falls back to the built-in STT model", async () => {
    const audio = path.join(tmp, "clip.mp3");
    fs.writeFileSync(audio, new Uint8Array([0xff, 0xfb, 0x90, 0x00]));
    const call = await runWithEnvFile("OPENAI_STT_MODEL=\n", [
      "openai",
      "transcribe",
      "--input",
      audio,
    ]);
    expect(call.body?.model).toBe(DEFAULT_OPENAI_STT_MODEL);
  });

  it("gemini generate falls back to the built-in image model in the request URL", async () => {
    const call = await runWithEnvFile("IMAGE_GEN_MODEL=\nGEMINI_IMAGE_GEN_MODEL=\n", [
      "gemini",
      "generate",
      "--prompt",
      "a cat",
    ]);
    expect(call.url).toContain(`models/${IMAGE_MODEL_DEFAULT}:`);
  });

  it("gemini defaults skip a blank primary name and fall back per task", () => {
    fs.writeFileSync(
      path.join(tmp, ".env"),
      `${GEMINI_MODEL_ENVS.map((name) => `${name}=`).join("\n")}\nGEMINI_IMAGE_GEN_MODEL=file-image\n`,
    );
    loadEnv({ isProjectEnvName });
    expect(getDefaultModel("generate")).toBe("file-image");
    expect(getDefaultModel("generate-video")).toBe(VIDEO_MODEL_DEFAULT);
    expect(getDefaultModel("generate-speech")).toBe(TTS_MODEL_DEFAULT);
    expect(getDefaultModel("analyze")).toBe(ANALYSIS_MODEL_DEFAULT);
  });

  it("gemini shell value still wins over the .env file", () => {
    process.env.GEMINI_MODEL = "shell-model";
    fs.writeFileSync(path.join(tmp, ".env"), "GEMINI_MODEL=file-model\n");
    loadEnv({ isProjectEnvName });
    expect(getDefaultModel("analyze")).toBe("shell-model");
  });
});

describe("whitespace model overrides fall back and padded ones are trimmed", () => {
  it("openai generate", async () => {
    const blank = await runWithEnvFile("OPENAI_IMAGE_MODEL=   \n", [
      "openai",
      "generate",
      "--driver",
      "api",
      "--prompt",
      "a cat",
    ]);
    expect(blank.body?.model).toBe(DEFAULT_OPENAI_IMAGE_MODEL);
    calls = [];
    // The first load put the blank value in process.env, where it now reads like a shell value.
    Reflect.deleteProperty(process.env, "OPENAI_IMAGE_MODEL");
    _resetEnvLoader();
    const padded = await runWithEnvFile('OPENAI_IMAGE_MODEL="  gpt-image-1  "\n', [
      "openai",
      "generate",
      "--driver",
      "api",
      "--prompt",
      "a cat",
    ]);
    expect(padded.body?.model).toBe("gpt-image-1");
  });

  it("openrouter generate", async () => {
    const call = await runWithEnvFile('OPENROUTER_IMAGE_MODEL="  "\n', [
      "openrouter",
      "generate",
      "--prompt",
      "a cat",
    ]);
    expect(call.body?.model).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it("openrouter image-to-video", async () => {
    const call = await runWithEnvFile('OPENROUTER_VIDEO_MODEL=" kwaivgi/kling-v3 "\n', [
      "openrouter",
      "image-to-video",
      "--prompt",
      "a cat",
      "--image-url",
      "https://example.com/cat.png",
    ]);
    expect(call.body?.model).toBe("kwaivgi/kling-v3");
  });
});

describe("a blank project .env value does not hide ~/.multix/.env", () => {
  let home: string;

  beforeEach(() => {
    home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, ".multix"), { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(home);
    Reflect.deleteProperty(process.env, "MULTIX_DISABLE_HOME_ENV");
  });

  const writeHome = (body: string) => fs.writeFileSync(path.join(home, ".multix", ".env"), body);

  it("uses the home model default and API key behind blank project lines", async () => {
    Reflect.deleteProperty(process.env, "FAL_KEY");
    writeHome("FAL_KEY=home-fal-key\nFAL_IMAGE_MODEL=fal-ai/flux-pro\n");
    const call = await runWithEnvFile("FAL_KEY=\nFAL_IMAGE_MODEL=  \n", ["fal", "image", "a cat"]);
    expect(call.url).toContain("/fal-ai/flux-pro");
    // The key from ~/.multix/.env is the one on the outgoing request.
    expect(call.headers.get("authorization")).toBe("Key home-fal-key");
    expect(process.env.FAL_KEY).toBe("home-fal-key");
    expect(envFileOrigin("FAL_KEY")).toEqual({
      source: "user",
      file: path.join(home, ".multix", ".env"),
    });
    expect(envFileOrigin("FAL_IMAGE_MODEL")?.source).toBe("user");
  });

  it("a non-blank project value still wins over home", async () => {
    writeHome("FAL_IMAGE_MODEL=fal-ai/flux-pro\n");
    const call = await runWithEnvFile("FAL_IMAGE_MODEL=fal-ai/project-model\n", [
      "fal",
      "image",
      "a cat",
    ]);
    expect(call.url).toContain("/fal-ai/project-model");
  });

  it("a shell value still wins over both files", async () => {
    process.env.FAL_IMAGE_MODEL = "fal-ai/shell-model";
    writeHome("FAL_IMAGE_MODEL=fal-ai/flux-pro\n");
    const call = await runWithEnvFile("FAL_IMAGE_MODEL=\n", ["fal", "image", "a cat"]);
    expect(call.url).toContain("/fal-ai/shell-model");
  });
});
