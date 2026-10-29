import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../../../src/agent/run-state.js";
import { classifyError } from "../../../../src/core/error-classify.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerGenerateCommand } from "../../../../src/providers/gemini/commands/generate.js";
import { _resetGeminiKeyCooldowns } from "../../../../src/providers/gemini/key-pool.js";

const savedEnv: Record<string, string | undefined> = {};
let logged: string[];

function program(): Command {
  const root = new Command();
  root.exitOverride();
  registerGenerateCommand(root);
  return root;
}

async function runAndCatch(extra: string[] = []): Promise<unknown> {
  try {
    await program().parseAsync(["generate", "--prompt", "a cat", "--model", "gemini-x", ...extra], {
      from: "user",
    });
  } catch (error) {
    return error;
  }
  throw new Error("expected generate to throw");
}

beforeEach(() => {
  logged = [];
  run.partial = undefined;
  _resetGeminiKeyCooldowns();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GEMINI_API_KEY")) {
      savedEnv[k] = process.env[k];
      Reflect.deleteProperty(process.env, k);
    }
  }
  process.env.GEMINI_API_KEY = "test-key-1";
  vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
    logged.push(String(msg));
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation((msg?: unknown) => {
    logged.push(String(msg));
  });
  vi.spyOn(process, "exit").mockImplementation((code?: unknown) => {
    throw new Error(`process.exit(${String(code)})`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GEMINI_API_KEY")) Reflect.deleteProperty(process.env, k);
  }
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

describe("gemini generate failures", () => {
  it("throws a network error as itself, not as a failed job", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const error = await runAndCatch();
    expect(String(error)).not.toMatch(/process\.exit/);
    expect(classifyError(error).code).toBe("NETWORK_ERROR");
    expect(logged.join("\n")).not.toMatch(/Generation failed/);
  });

  it("keeps the HTTP status of a rejected request", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: { message: "bad prompt field" } }), { status: 400 }),
    );
    const info = classifyError(await runAndCatch());
    expect(info).toMatchObject({ code: "PROVIDER_REJECTED", http_status: 400 });
  });

  it("names the images saved before a later request fails and keeps its error", async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-gen-"));
    const savedOutputDir = process.env.MULTIX_OUTPUT_DIR;
    process.env.MULTIX_OUTPUT_DIR = outDir;
    _resetOutputDir();
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      if (calls === 1) {
        const image = { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } };
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [image] } }] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
    });
    try {
      const info = classifyError(await runAndCatch(["--num-images", "3"]));
      expect(info).toMatchObject({ code: "PROVIDER_UNAVAILABLE", http_status: 503 });
      const saved = fs.readdirSync(outDir);
      expect(saved).toHaveLength(1);
      const warning = logged.join("\n");
      expect(warning).toContain("Request 2 of 3 failed after 1 image(s) were saved");
      expect(warning).toContain(path.join(outDir, saved[0] as string));
      expect(warning).toContain("--num-images 2");
      expect(run.partial?.rerunArgs).toEqual(["--num-images", "2"]);
    } finally {
      if (savedOutputDir === undefined) Reflect.deleteProperty(process.env, "MULTIX_OUTPUT_DIR");
      else process.env.MULTIX_OUTPUT_DIR = savedOutputDir;
      _resetOutputDir();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("counts saved images, not requests, when one response had no image", async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-gen-"));
    const savedOutputDir = process.env.MULTIX_OUTPUT_DIR;
    process.env.MULTIX_OUTPUT_DIR = outDir;
    _resetOutputDir();
    const image = { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } };
    const replies = [
      () => new Response(JSON.stringify({ candidates: [{ content: { parts: [] } }] })),
      () => new Response(JSON.stringify({ candidates: [{ content: { parts: [image] } }] })),
      () => new Response("{}", { status: 503 }),
    ];
    let calls = 0;
    vi.stubGlobal("fetch", async () => (replies[calls++] as () => Response)());
    try {
      await runAndCatch(["--num-images", "3"]);
      expect(fs.readdirSync(outDir)).toHaveLength(1);
      expect(run.partial?.rerunArgs).toEqual(["--num-images", "2"]);
    } finally {
      if (savedOutputDir === undefined) Reflect.deleteProperty(process.env, "MULTIX_OUTPUT_DIR");
      else process.env.MULTIX_OUTPUT_DIR = savedOutputDir;
      _resetOutputDir();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("adds no saved-images warning when the first request fails", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
    await runAndCatch(["--num-images", "3"]);
    expect(logged.join("\n")).not.toMatch(/were saved/);
    expect(run.partial).toBeUndefined();
  });
});
