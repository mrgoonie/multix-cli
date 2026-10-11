import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, HttpError } from "../../../../src/core/errors.js";
import type { Logger } from "../../../../src/core/logger.js";
import { generateContent } from "../../../../src/providers/gemini/client.js";
import {
  _resetGeminiKeyCooldowns,
  isGeminiRateLimitError,
  listGeminiKeys,
  withGeminiKey,
} from "../../../../src/providers/gemini/key-pool.js";

const ENV = {
  GEMINI_API_KEY: "key-primary-0000",
  GEMINI_API_KEY_10: "key-ten-00000000",
  GEMINI_API_KEY_2: "key-two-00000000",
  GEMINI_API_KEY_3: "key-primary-0000", // duplicate value is dropped
  GEMINI_API_KEY_X: "ignored-non-numeric",
};

function fakeLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  const noop = () => {};
  return {
    warnings,
    info: noop,
    debug: noop,
    success: noop,
    error: noop,
    header: noop,
    warn: (m: string) => warnings.push(m),
  } as unknown as Logger & { warnings: string[] };
}

const rateLimited = (retryAfterMs?: number) =>
  new HttpError(429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}', "https://x", retryAfterMs);

beforeEach(() => _resetGeminiKeyCooldowns());

describe("listGeminiKeys", () => {
  it("orders the primary key then numeric suffixes, dropping duplicates", () => {
    expect(listGeminiKeys(ENV).map((k) => k.name)).toEqual([
      "GEMINI_API_KEY",
      "GEMINI_API_KEY_2",
      "GEMINI_API_KEY_10",
    ]);
  });

  it("works without a primary key", () => {
    expect(listGeminiKeys({ GEMINI_API_KEY_2: "k2" }).map((k) => k.name)).toEqual([
      "GEMINI_API_KEY_2",
    ]);
  });
});

describe("isGeminiRateLimitError", () => {
  it("detects 429 and RESOURCE_EXHAUSTED", () => {
    expect(isGeminiRateLimitError(rateLimited())).toBe(true);
    expect(isGeminiRateLimitError(new HttpError(400, "RESOURCE_EXHAUSTED", "u"))).toBe(true);
    expect(isGeminiRateLimitError(new Error("File upload failed (HTTP 429): quota"))).toBe(true);
    expect(isGeminiRateLimitError(new HttpError(403, "denied", "u"))).toBe(false);
    expect(isGeminiRateLimitError("nope")).toBe(false);
  });
});

describe("withGeminiKey", () => {
  it("throws ConfigError when no key is configured", async () => {
    await expect(withGeminiKey(async () => 1, { env: {} })).rejects.toBeInstanceOf(ConfigError);
  });

  it("rotates on rate limits and logs env names only", async () => {
    const logger = fakeLogger();
    const used: string[] = [];
    const out = await withGeminiKey(
      async (key, name) => {
        used.push(name);
        if (name !== "GEMINI_API_KEY_10") throw rateLimited();
        return key;
      },
      { env: ENV, logger },
    );
    expect(out).toBe("key-ten-00000000");
    expect(used).toEqual(["GEMINI_API_KEY", "GEMINI_API_KEY_2", "GEMINI_API_KEY_10"]);
    expect(logger.warnings.join("\n")).toContain("GEMINI_API_KEY is rate-limited");
    expect(logger.warnings.join("\n")).not.toMatch(/key-(primary|two|ten)/);
  });

  it("does not rotate on other errors", async () => {
    const used: string[] = [];
    await expect(
      withGeminiKey(
        async (_k, name) => {
          used.push(name);
          throw new HttpError(403, "denied", "https://x");
        },
        { env: ENV },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(used).toEqual(["GEMINI_API_KEY"]);
  });

  it("skips cooling keys on later calls until the cooldown expires", async () => {
    let t = 0;
    const now = () => t;
    await withGeminiKey(
      async (_k, name) => {
        if (name === "GEMINI_API_KEY") throw rateLimited(5_000);
        return name;
      },
      { env: ENV, now },
    );
    const first = await withGeminiKey(async (_k, name) => name, { env: ENV, now });
    expect(first).toBe("GEMINI_API_KEY_2");

    t = 5_001;
    const later = await withGeminiKey(async (_k, name) => name, { env: ENV, now });
    expect(later).toBe("GEMINI_API_KEY");
  });

  it("rethrows the last rate-limit error when every key is exhausted", async () => {
    const logger = fakeLogger();
    await expect(
      withGeminiKey(
        async () => {
          throw rateLimited();
        },
        { env: ENV, logger },
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(logger.warnings.at(-1)).toBe("All 3 Gemini keys are rate-limited");
  });
});

describe("gemini client rotation", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("GEMINI_API_KEY")) delete process.env[k];
    }
    process.env.GEMINI_API_KEY = "client-key-one-0";
    process.env.GEMINI_API_KEY_2 = "client-key-two-0";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it("retries generateContent with the next key after a 429", async () => {
    const keys: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>)["x-goog-api-key"] as string;
      keys.push(key);
      if (key === "client-key-one-0") {
        return new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}', { status: 429 });
      }
      return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
    });
    await generateContent({ model: "m", contents: [{ parts: [{ text: "hi" }] }] });
    expect(keys).toEqual(["client-key-one-0", "client-key-two-0"]);
  });

  it("uses a pinned key without rotating", async () => {
    const keys: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      keys.push((init.headers as Record<string, string>)["x-goog-api-key"] as string);
      return new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}', { status: 429 });
    });
    await expect(
      generateContent(
        { model: "m", contents: [{ parts: [{ text: "hi" }] }] },
        { apiKey: "pinned-key-0000" },
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(keys).toEqual(["pinned-key-0000"]);
  });
});
