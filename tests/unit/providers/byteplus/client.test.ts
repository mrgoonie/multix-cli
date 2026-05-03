/**
 * Unit tests for BytePlusClient — verifies Bearer auth, base URL,
 * and key resolution chain (BYTEPLUS_API_KEY → ARK_API_KEY).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BytePlusClient, requireBytePlusKey } from "../../../../src/providers/byteplus/client.js";

describe("BytePlusClient.request", () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; init: RequestInit } | undefined;

  beforeEach(() => {
    captured = undefined;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses configured base URL", async () => {
    const client = new BytePlusClient("k", "https://ark.example.com/api/v3");
    await client.get("/images/generations");
    expect(captured?.url).toBe("https://ark.example.com/api/v3/images/generations");
  });

  it("sends Bearer auth header", async () => {
    const client = new BytePlusClient("my-secret", "https://ark.example.com/api/v3");
    await client.get("/x");
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer my-secret");
  });

  it("appends query params", async () => {
    const client = new BytePlusClient("k", "https://ark.example.com/api/v3");
    await client.get("/x", { limit: 5, name: "abc" });
    expect(captured?.url).toContain("limit=5");
    expect(captured?.url).toContain("name=abc");
  });
});

describe("requireBytePlusKey", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("prefers BYTEPLUS_API_KEY over ARK_API_KEY", () => {
    process.env.BYTEPLUS_API_KEY = "primary";
    process.env.ARK_API_KEY = "fallback";
    expect(requireBytePlusKey()).toBe("primary");
  });

  it("falls back to ARK_API_KEY when BYTEPLUS_API_KEY missing", () => {
    process.env.BYTEPLUS_API_KEY = "";
    process.env.ARK_API_KEY = "fallback";
    expect(requireBytePlusKey()).toBe("fallback");
  });

  it("throws ConfigError when neither set", () => {
    process.env.BYTEPLUS_API_KEY = "";
    process.env.ARK_API_KEY = "";
    expect(() => requireBytePlusKey()).toThrow(/BytePlus API key not set/);
  });
});
