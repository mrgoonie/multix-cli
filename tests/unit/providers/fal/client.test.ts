/**
 * Unit tests for FalClient — verifies path building and Key auth header.
 * Mocks globalThis.fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FalClient,
  resultPath,
  statusPath,
  submitPath,
} from "../../../../src/providers/fal/client.js";

describe("FalClient.request", () => {
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

  it("builds the submit URL from the model id", async () => {
    const client = new FalClient("test-key", "https://queue.fal.run");
    await client.post(submitPath("fal-ai/flux/schnell"), { prompt: "x" });
    expect(captured?.url).toBe("https://queue.fal.run/fal-ai/flux/schnell");
  });

  it("sends Key auth header", async () => {
    const client = new FalClient("my-secret", "https://queue.fal.run");
    await client.get("/fal-ai/flux/schnell/requests/abc/status");
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Key my-secret");
  });

  it("builds status and result paths for multi-segment model ids", () => {
    expect(statusPath("fal-ai/flux/schnell", "req-1")).toBe(
      "/fal-ai/flux/schnell/requests/req-1/status",
    );
    expect(resultPath("fal-ai/flux/schnell", "req-1")).toBe("/fal-ai/flux/schnell/requests/req-1");
  });
});
