import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyError } from "../../../../src/core/error-classify.js";
import { registerMinimaxImageToImageCommand } from "../../../../src/providers/minimax/commands/image-to-image.js";

let logged: string[];

async function runAndCatch(): Promise<unknown> {
  const root = new Command();
  root.exitOverride();
  registerMinimaxImageToImageCommand(root);
  try {
    await root.parseAsync(
      ["image-to-image", "--prompt", "a cat", "--ref", "https://example.com/face.png"],
      { from: "user" },
    );
  } catch (error) {
    return error;
  }
  throw new Error("expected image-to-image to throw");
}

beforeEach(() => {
  logged = [];
  vi.stubEnv("MINIMAX_API_KEY", "test-minimax-key");
  for (const m of ["error", "warn", "log"] as const) {
    vi.spyOn(console, m).mockImplementation((msg?: unknown) => {
      logged.push(String(msg));
    });
  }
  vi.spyOn(process, "exit").mockImplementation((code?: unknown) => {
    throw new Error(`process.exit(${String(code)})`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("minimax image-to-image failures", () => {
  it("keeps the HTTP status and Retry-After of a rate-limited request", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://api.minimax.io/v1/image_generation");
      return new Response(JSON.stringify({ error: "slow down" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "30" },
      });
    });
    const error = await runAndCatch();
    expect(String(error)).not.toMatch(/process\.exit/);
    expect(classifyError(error)).toMatchObject({
      code: "RATE_LIMITED",
      http_status: 429,
      retry_after_s: 30,
    });
  });

  it("throws a network error as itself", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const error = await runAndCatch();
    expect(String(error)).not.toMatch(/process\.exit/);
    expect(classifyError(error).code).toBe("NETWORK_ERROR");
  });
});
