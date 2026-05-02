import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../src/core/errors.js";

describe("httpJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON on 200", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const { httpJson } = await import("../../../src/core/http-client.js");
    const result = await httpJson<{ ok: boolean }>({ url: "https://example.com/api" });
    expect(result.ok).toBe(true);
  });

  it("throws HttpError on 4xx", async () => {
    vi.stubGlobal("fetch", async () => new Response("Unauthorized", { status: 401 }));
    const { httpJson } = await import("../../../src/core/http-client.js");
    await expect(httpJson({ url: "https://example.com/api" })).rejects.toThrow(HttpError);
  });

  it("throws HttpError with correct status on 403", async () => {
    vi.stubGlobal("fetch", async () => new Response("Forbidden", { status: 403 }));
    const { httpJson } = await import("../../../src/core/http-client.js");
    try {
      await httpJson({ url: "https://example.com/api" });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(403);
    }
  });

  it("sends POST and parses response", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ received: true }), { status: 200 }),
    );
    const { httpJson } = await import("../../../src/core/http-client.js");
    const result = await httpJson<{ received: boolean }>({
      url: "https://api.test/endpoint",
      method: "POST",
      body: { hello: "world" },
    });
    expect(result.received).toBe(true);
  });

  it("throws HttpError when fetch rejects (network error)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("Network error");
    });
    const { httpJson } = await import("../../../src/core/http-client.js");
    await expect(httpJson({ url: "https://unreachable.test/api" })).rejects.toThrow(HttpError);
  });
});

describe("fetchBytes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes data URI without network call", async () => {
    const { fetchBytes } = await import("../../../src/core/http-client.js");
    // "hello" in base64
    const dataUri = "data:text/plain;base64,aGVsbG8=";
    const bytes = await fetchBytes(dataUri);
    expect(bytes.toString()).toBe("hello");
  });

  it("throws on malformed data URI (no comma)", async () => {
    const { fetchBytes } = await import("../../../src/core/http-client.js");
    await expect(fetchBytes("data:nocomma")).rejects.toThrow("Malformed data URI");
  });
});
