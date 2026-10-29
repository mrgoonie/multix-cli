import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

async function runAndCatch(): Promise<unknown> {
  try {
    await program().parseAsync(["generate", "--prompt", "a cat", "--model", "gemini-x"], {
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
});
