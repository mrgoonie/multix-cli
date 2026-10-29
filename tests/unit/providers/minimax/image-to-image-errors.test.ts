import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyError } from "../../../../src/core/error-classify.js";
import { registerMinimaxImageToImageCommand } from "../../../../src/providers/minimax/commands/image-to-image.js";

let logged: string[];
let calledUrls: string[];

function stubFetch(reply: () => Response): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    calledUrls.push(String(input instanceof Request ? input.url : input));
    return reply();
  });
}

/** The failure came from the image_generation call, and nothing re-logged it as an exit. */
function expectThrownFromGeneration(error: unknown): void {
  expect(String(error)).not.toMatch(/process\.exit/);
  expect(calledUrls).toEqual(["https://api.minimax.io/v1/image_generation"]);
  expect(logged.join("\n")).not.toMatch(/✗/);
}

async function runAndCatch(): Promise<unknown> {
  const root = new Command();
  root.exitOverride();
  registerMinimaxImageToImageCommand(root);
  try {
    await root.parseAsync(
      ["image-to-image", "--prompt", "a hero", "--ref", "https://example.test/face.png"],
      { from: "user" },
    );
  } catch (error) {
    return error;
  }
  throw new Error("expected image-to-image to throw");
}

beforeEach(() => {
  logged = [];
  calledUrls = [];
  vi.stubEnv("NO_COLOR", "1");
  vi.stubEnv("MINIMAX_API_KEY", "test-minimax-key");
  for (const m of ["log", "warn", "error"] as const) {
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
  it("throws a rate limit as itself, keeping Retry-After", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: "too many requests" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "30" },
        }),
    );
    const error = await runAndCatch();
    expectThrownFromGeneration(error);
    expect(classifyError(error)).toMatchObject({
      code: "RATE_LIMITED",
      http_status: 429,
      retry_after_s: 30,
    });
  });

  it("throws a network failure as itself, not as a logged exit", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const error = await runAndCatch();
    expectThrownFromGeneration(error);
    expect(classifyError(error).code).toBe("NETWORK_ERROR");
  });

  it("throws a MiniMax base_resp error as a provider error", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ base_resp: { status_code: 1008, status_msg: "insufficient balance" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const error = await runAndCatch();
    expectThrownFromGeneration(error);
    expect(classifyError(error).code).toBe("QUOTA_EXCEEDED");
  });
});
