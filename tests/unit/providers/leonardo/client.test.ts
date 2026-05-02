/**
 * Unit tests for LeonardoClient — verifies v2: prefix swap and Bearer auth.
 * Mocks globalThis.fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeonardoClient } from "../../../../src/providers/leonardo/client.js";
import { isGptImageModel } from "../../../../src/providers/leonardo/models.js";

describe("LeonardoClient.request", () => {
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

  it("uses v1 base for non-prefixed paths", async () => {
    const client = new LeonardoClient("test-key", "https://cloud.leonardo.ai/api/rest/v1");
    await client.get("/me");
    expect(captured?.url).toBe("https://cloud.leonardo.ai/api/rest/v1/me");
  });

  it("swaps to v2 base for v2: prefix", async () => {
    const client = new LeonardoClient("test-key", "https://cloud.leonardo.ai/api/rest/v1");
    await client.post("v2:/generations", { prompt: "x" });
    expect(captured?.url).toBe("https://cloud.leonardo.ai/api/rest/v2/generations");
  });

  it("sends Bearer auth header", async () => {
    const client = new LeonardoClient("my-secret");
    await client.get("/me");
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer my-secret");
  });

  it("appends query params", async () => {
    const client = new LeonardoClient("k");
    await client.get("/x", { limit: 5, name: "abc" });
    expect(captured?.url).toContain("limit=5");
    expect(captured?.url).toContain("name=abc");
  });
});

describe("isGptImageModel", () => {
  it("matches gpt-image- prefix", () => {
    expect(isGptImageModel("gpt-image-1")).toBe(true);
    expect(isGptImageModel("gpt-image-anything")).toBe(true);
  });

  it("rejects other model ids", () => {
    expect(isGptImageModel("7b592283-e8a7-4c5a-9ba6-d18c31f258b9")).toBe(false);
    expect(isGptImageModel("MOTION2")).toBe(false);
    expect(isGptImageModel(undefined)).toBe(false);
  });
});
