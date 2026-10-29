import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../../../src/agent/run-state.js";
import { classifyError } from "../../../../src/core/error-classify.js";
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
  vi.spyOn(process, "exit").mockImplementation((code?: unknown) => {
    throw new Error(`process.exit(${String(code)})`);
  });
});

afterEach(() => {
  run.partial = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

  it("finishes the saved images and records the remainder when a later request fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-gen-partial-"));
    vi.stubEnv("MULTIX_OUTPUT_DIR", dir);
    const image = {
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }] } },
      ],
    };
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify(image), { status: 200 })
        : new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
    });
    const output = path.join(dir, "out", "first.png");
    try {
      const error = await runAndCatch([
        "--num-images",
        "3",
        "--output",
        output,
        "--image-format",
        "original",
      ]);
      expect(calls).toBe(2);
      expect(classifyError(error)).toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        http_status: 503,
      });
      expect(fs.readdirSync(dir).filter((f) => f.startsWith("gemini_generated_"))).toHaveLength(1);
      expect(fs.existsSync(output)).toBe(true);
      expect(run.partial).toEqual({ options: { "--num-images": "2", "--output": null } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records no remainder when the first request fails", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
    await runAndCatch(["--num-images", "3"]);
    expect(run.partial).toBeUndefined();
  });
});
