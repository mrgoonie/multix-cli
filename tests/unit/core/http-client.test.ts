import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, HttpError } from "../../../src/core/errors.js";
import {
  DownloadTooLargeError,
  downloadFile,
  downloadToFile,
  maxDownloadBytes,
} from "../../../src/core/http-client.js";

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

describe("downloadToFile", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-dl-"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  /** Fetch fake keyed by URL; records each call's URL and headers. */
  function fakeFetch(routes: Record<string, () => Response>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const route = routes[url];
      if (!route) throw new Error(`no route for ${url}`);
      return route();
    };
    return { fetch, calls };
  }

  it("streams to a nested destination chosen from the response", async () => {
    const { fetch } = fakeFetch({
      "https://a.test/f": () => new Response(BYTES, { headers: { "content-type": "image/png" } }),
    });
    const result = await downloadToFile("https://a.test/f", {
      dest: (res) =>
        path.join(tmp, "deep", res.headers.get("content-type") === "image/png" ? "f.png" : "f"),
      fetch,
    });
    expect(result).toEqual({
      dest: path.join(tmp, "deep", "f.png"),
      contentType: "image/png",
      bytes: 8,
    });
    expect(new Uint8Array(fs.readFileSync(result.dest))).toEqual(BYTES);
  });

  it("rejects a declared Content-Length over maxBytes before writing", async () => {
    const { fetch } = fakeFetch({
      "https://a.test/f": () => new Response(BYTES, { headers: { "content-length": "8" } }),
    });
    const dest = path.join(tmp, "f.bin");
    await expect(downloadToFile("https://a.test/f", { dest, maxBytes: 4, fetch })).rejects.toThrow(
      DownloadTooLargeError,
    );
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("counts streamed bytes when Content-Length is missing and removes the partial file", async () => {
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(BYTES);
          controller.enqueue(BYTES);
          controller.close();
        },
      });
    const { fetch } = fakeFetch({ "https://a.test/f": () => new Response(stream()) });
    const dest = path.join(tmp, "f.bin");
    const err = await downloadToFile("https://a.test/f?sig=SECRET", {
      dest,
      maxBytes: 10,
      fetch: (_url, init) => fetch("https://a.test/f", init),
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(DownloadTooLargeError);
    expect(err.message).toContain("MULTIX_MAX_DOWNLOAD_MB");
    expect(err.message).not.toContain("SECRET");
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("validates each redirect hop and drops headers when the origin changes", async () => {
    const { fetch, calls } = fakeFetch({
      "https://a.test/f": () => new Response(null, { status: 302, headers: { location: "/g" } }),
      "https://a.test/g": () =>
        new Response(null, { status: 301, headers: { location: "https://b.test/h" } }),
      "https://b.test/h": () => new Response(BYTES),
    });
    const seen: string[] = [];
    const result = await downloadToFile("https://a.test/f", {
      dest: path.join(tmp, "f.bin"),
      headers: { authorization: "Bearer k" },
      validateUrl: (url) => seen.push(url),
      fetch,
    });
    expect(result.bytes).toBe(8);
    expect(seen).toEqual(["https://a.test/f", "https://a.test/g", "https://b.test/h"]);
    expect(calls.map((c) => c.init?.redirect)).toEqual(["manual", "manual", "manual"]);
    expect(calls.map((c) => Boolean(c.init?.headers))).toEqual([true, true, false]);
  });

  it("stops when the validator refuses a redirect target", async () => {
    const { fetch, calls } = fakeFetch({
      "https://a.test/f": () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }),
    });
    await expect(
      downloadToFile("https://a.test/f", {
        dest: path.join(tmp, "f.bin"),
        validateUrl: (url) => {
          if (url.startsWith("http:")) throw new Error("refused");
        },
        fetch,
      }),
    ).rejects.toThrow("refused");
    expect(calls).toHaveLength(1);
  });

  it("gives up after 5 redirects", async () => {
    const { fetch, calls } = fakeFetch({
      "https://a.test/f": () => new Response(null, { status: 302, headers: { location: "/f" } }),
    });
    await expect(
      downloadToFile("https://a.test/f", {
        dest: path.join(tmp, "f.bin"),
        validateUrl: () => {},
        fetch,
      }),
    ).rejects.toThrow(/too many redirects/);
    expect(calls).toHaveLength(6);
  });

  it("throws HttpError for non-2xx and network failures", async () => {
    const { fetch } = fakeFetch({
      "https://a.test/f": () => new Response("gone", { status: 410 }),
    });
    const dest = path.join(tmp, "f.bin");
    const err = await downloadToFile("https://a.test/f", { dest, fetch }).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(410);
    await expect(downloadToFile("https://a.test/x", { dest, fetch })).rejects.toThrow(HttpError);
  });

  it("downloadFile keeps its contract and uses global fetch", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(BYTES, { headers: { "content-type": "video/mp4" } }),
    );
    const dest = path.join(tmp, "v", "clip.mp4");
    expect(await downloadFile("https://a.test/v", dest)).toBe("video/mp4");
    expect(fs.statSync(dest).size).toBe(8);
  });
});

describe("maxDownloadBytes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 2048 MB and honours MULTIX_MAX_DOWNLOAD_MB", () => {
    vi.stubEnv("MULTIX_MAX_DOWNLOAD_MB", "");
    expect(maxDownloadBytes()).toBe(2048 * 1024 * 1024);
    vi.stubEnv("MULTIX_MAX_DOWNLOAD_MB", "1.5");
    expect(maxDownloadBytes()).toBe(Math.floor(1.5 * 1024 * 1024));
  });

  it("rejects non-positive or non-numeric values", () => {
    for (const bad of ["0", "-1", "abc", "Infinity"]) {
      vi.stubEnv("MULTIX_MAX_DOWNLOAD_MB", bad);
      expect(() => maxDownloadBytes()).toThrow(ConfigError);
    }
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
