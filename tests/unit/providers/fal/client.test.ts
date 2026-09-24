/**
 * Unit tests for FalClient — verifies path building, app-id truncation for
 * status/result URLs, and Key auth header.
 * Mocks globalThis.fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import {
  FalClient,
  appIdFromModel,
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

  it("builds the submit URL from the full model id (all segments)", async () => {
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

  it("requestAbsolute sends the same Key auth header to an arbitrary URL", async () => {
    const client = new FalClient("my-secret", "https://queue.fal.run");
    await client.getAbsolute("https://queue.fal.run/fal-ai/flux/requests/abc/status");
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Key my-secret");
    expect(captured?.url).toBe("https://queue.fal.run/fal-ai/flux/requests/abc/status");
  });
});

describe("appIdFromModel", () => {
  it("truncates a multi-segment model id to owner/alias", () => {
    expect(appIdFromModel("fal-ai/flux/schnell")).toBe("fal-ai/flux");
    expect(appIdFromModel("fal-ai/kling-video/v1.6/standard/text-to-video")).toBe(
      "fal-ai/kling-video",
    );
  });

  it("keeps a two-segment model id unchanged", () => {
    expect(appIdFromModel("fal-ai/flux")).toBe("fal-ai/flux");
  });

  it("throws ValidationError for a model id with fewer than 2 segments", () => {
    expect(() => appIdFromModel("fal-ai")).toThrow(ValidationError);
    expect(() => appIdFromModel("")).toThrow(ValidationError);
  });
});

describe("statusPath / resultPath", () => {
  it("use the app id (first two segments), not the full model id", () => {
    expect(statusPath("fal-ai/kling-video/v1.6/standard/text-to-video", "req-1")).toBe(
      "/fal-ai/kling-video/requests/req-1/status",
    );
    expect(resultPath("fal-ai/kling-video/v1.6/standard/text-to-video", "req-1")).toBe(
      "/fal-ai/kling-video/requests/req-1",
    );
  });

  it("pass through a two-segment model id unchanged", () => {
    expect(statusPath("fal-ai/flux", "req-1")).toBe("/fal-ai/flux/requests/req-1/status");
    expect(resultPath("fal-ai/flux", "req-1")).toBe("/fal-ai/flux/requests/req-1");
  });
});
