/**
 * Unit tests for FalClient — verifies path building, app-id truncation for
 * status/result URLs, and Key auth header.
 * Mocks globalThis.fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, ValidationError } from "../../../../src/core/errors.js";
import {
  FalClient,
  appIdFromModel,
  assertTrustedFalUrl,
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

  it("requestAbsolute refuses an untrusted host without sending any request", async () => {
    const client = new FalClient("my-secret", "https://queue.fal.run");
    const err = await client
      .getAbsolute("https://evil.example/steal?token=abc")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toContain("evil.example");
    expect((err as Error).message).not.toContain("token");
    expect((err as Error).message).not.toContain("my-secret");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("assertTrustedFalUrl", () => {
  const STATUS = "/fal-ai/flux/requests/abc/status";

  it("accepts https on the fal queue host and on the configured base host", () => {
    expect(() =>
      assertTrustedFalUrl(`https://queue.fal.run${STATUS}`, "https://queue.fal.run"),
    ).not.toThrow();
    expect(() =>
      assertTrustedFalUrl(`https://queue.fal.run${STATUS}`, "https://proxy.example.com"),
    ).not.toThrow();
    expect(() =>
      assertTrustedFalUrl(`https://proxy.example.com${STATUS}`, "https://proxy.example.com/fal"),
    ).not.toThrow();
  });

  it("refuses a foreign host, including lookalike subdomains", () => {
    for (const url of [
      `https://evil.example${STATUS}`,
      `https://queue.fal.run.evil.example${STATUS}`,
      `https://evil.queue.fal.run${STATUS}`,
    ]) {
      expect(() => assertTrustedFalUrl(url, "https://queue.fal.run")).toThrow(ProviderError);
    }
  });

  it("normalises case, a trailing dot and an explicit default port", () => {
    for (const url of [
      `https://QUEUE.FAL.RUN${STATUS}`,
      `https://queue.fal.run.${STATUS}`,
      `https://queue.fal.run:443${STATUS}`,
    ]) {
      expect(() => assertTrustedFalUrl(url, "https://proxy.example.com")).not.toThrow();
    }
  });

  it("refuses the userinfo trick (the real host is after the @)", () => {
    expect(() =>
      assertTrustedFalUrl(`https://queue.fal.run@evil.example${STATUS}`, "https://queue.fal.run"),
    ).toThrow(/evil\.example/);
  });

  it("refuses a non-default port on the fal queue host", () => {
    expect(() =>
      assertTrustedFalUrl(`https://queue.fal.run:8443${STATUS}`, "https://queue.fal.run"),
    ).toThrow(ProviderError);
  });

  it("refuses plain http on the fal queue host", () => {
    expect(() =>
      assertTrustedFalUrl(`http://queue.fal.run${STATUS}?x=1`, "https://queue.fal.run"),
    ).toThrow(ProviderError);
  });

  it("allows loopback only on the same origin as a loopback base URL", () => {
    expect(() =>
      assertTrustedFalUrl(`http://127.0.0.1:8787${STATUS}`, "http://127.0.0.1:8787"),
    ).not.toThrow();
    expect(() =>
      assertTrustedFalUrl(`http://127.0.0.1:8787${STATUS}`, "https://queue.fal.run"),
    ).toThrow(ProviderError);
    // A different loopback name or port than the base is a different origin.
    expect(() =>
      assertTrustedFalUrl(`http://localhost:8787${STATUS}`, "http://127.0.0.1:8787"),
    ).toThrow(ProviderError);
    expect(() =>
      assertTrustedFalUrl(`http://127.0.0.1:9999${STATUS}`, "http://127.0.0.1:8787"),
    ).toThrow(ProviderError);
  });

  it("allows an IPv6 loopback base's own origin", () => {
    expect(() =>
      assertTrustedFalUrl(`http://[::1]:8787${STATUS}`, "http://[::1]:8787"),
    ).not.toThrow();
    expect(() => assertTrustedFalUrl(`http://[::1]:9999${STATUS}`, "http://[::1]:8787")).toThrow(
      ProviderError,
    );
  });

  it("allows a private-IP https base's own origin and still refuses a foreign host", () => {
    const base = "https://10.0.0.5";
    expect(() => assertTrustedFalUrl(`https://10.0.0.5${STATUS}`, base)).not.toThrow();
    expect(() => assertTrustedFalUrl(`https://evil.example${STATUS}`, base)).toThrow(ProviderError);
    expect(() => assertTrustedFalUrl(`https://10.0.0.6${STATUS}`, base)).toThrow(ProviderError);
  });

  it("allows an http non-loopback proxy base's own origin and still refuses a foreign host", () => {
    const base = "http://fal-proxy.internal:8080";
    expect(() =>
      assertTrustedFalUrl(`http://fal-proxy.internal:8080${STATUS}`, base),
    ).not.toThrow();
    expect(() => assertTrustedFalUrl(`http://evil.example:8080${STATUS}`, base)).toThrow(
      ProviderError,
    );
    // Same host but another scheme or port is a different origin.
    expect(() => assertTrustedFalUrl(`https://fal-proxy.internal${STATUS}`, base)).toThrow(
      ProviderError,
    );
  });

  it("refuses a malformed URL", () => {
    expect(() => assertTrustedFalUrl("not a url", "https://queue.fal.run")).toThrow(/malformed/);
  });

  it("names the host only, never the path or query string", () => {
    try {
      assertTrustedFalUrl("https://evil.example/a/b?key=secret-value", "https://queue.fal.run");
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("evil.example");
      expect(msg).not.toContain("secret-value");
      expect(msg).not.toContain("/a/b");
    }
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
