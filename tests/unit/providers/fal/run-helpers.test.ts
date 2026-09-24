import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import {
  downloadResultMedia,
  extractMediaUrls,
  extractMediaUrlsGeneric,
  parseInputArg,
  submitAndWait,
} from "../../../../src/providers/fal/run-helpers.js";

const noopLogger = {
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  header: vi.fn(),
};

describe("parseInputArg", () => {
  it("parses inline JSON", () => {
    expect(parseInputArg('{"prompt":"hi"}')).toEqual({ prompt: "hi" });
  });

  it("reads JSON from an @file path", () => {
    const tmp = path.join(os.tmpdir(), `fal-input-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ prompt: "from file" }));
    try {
      expect(parseInputArg(`@${tmp}`)).toEqual({ prompt: "from file" });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it("throws ValidationError on invalid JSON", () => {
    expect(() => parseInputArg("not json")).toThrow(ValidationError);
  });

  it("throws ValidationError when input is not a JSON object", () => {
    expect(() => parseInputArg("[1,2,3]")).toThrow(ValidationError);
    expect(() => parseInputArg('"just a string"')).toThrow(ValidationError);
  });
});

describe("extractMediaUrls", () => {
  it("prefers the known images[].url shape over a generic scan", () => {
    const result = {
      images: [{ url: "https://x.test/a.png" }, { url: "https://x.test/b.png" }],
      seed: { url: "https://x.test/decoy.png" }, // not a known field; ignored because images[] matched
    };
    expect(extractMediaUrls(result)).toEqual(["https://x.test/a.png", "https://x.test/b.png"]);
  });

  it("prefers the known video.url shape", () => {
    const result = {
      video: { url: "https://x.test/c.mp4" },
      nested: { url: "https://x.test/d.mp4" },
    };
    expect(extractMediaUrls(result)).toEqual(["https://x.test/c.mp4"]);
  });

  it("falls back to a generic recursive scan when no known field matches", () => {
    const result = { nested: { deeply: { url: "https://x.test/e.png" } } };
    expect(extractMediaUrls(result)).toEqual(["https://x.test/e.png"]);
  });

  it("returns empty array for primitives", () => {
    expect(extractMediaUrls("hello")).toEqual([]);
    expect(extractMediaUrls(null)).toEqual([]);
    expect(extractMediaUrls(42)).toEqual([]);
  });
});

describe("extractMediaUrlsGeneric", () => {
  it("collects url fields recursively", () => {
    const result = {
      images: [{ url: "https://x.test/a.png" }, { url: "https://x.test/b.png" }],
      video: { url: "https://x.test/c.mp4" },
      seed: 42,
    };
    expect(extractMediaUrlsGeneric(result).sort()).toEqual(
      ["https://x.test/a.png", "https://x.test/b.png", "https://x.test/c.mp4"].sort(),
    );
  });

  it("ignores non-http url values", () => {
    expect(extractMediaUrlsGeneric({ url: "data:image/png;base64,xxx" })).toEqual([]);
  });
});

describe("submitAndWait", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FAL_KEY;

  beforeEach(() => {
    process.env.FAL_KEY = "test-key";
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) process.env.FAL_KEY = undefined;
    else process.env.FAL_KEY = originalKey;
  });

  const STATUS_URL = "https://queue.fal.run/fal-ai/flux/requests/req-1/status";
  const RESPONSE_URL = "https://queue.fal.run/fal-ai/flux/requests/req-1";

  it("polls the submit response's status_url/response_url (not a reconstructed path)", async () => {
    let statusCalls = 0;
    const seenUrls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      seenUrls.push(u);
      if (u.endsWith("/fal-ai/flux/schnell")) {
        return new Response(
          JSON.stringify({
            request_id: "req-1",
            status_url: STATUS_URL,
            response_url: RESPONSE_URL,
          }),
          { status: 200 },
        );
      }
      if (u === STATUS_URL) {
        statusCalls++;
        const status = statusCalls < 2 ? "IN_PROGRESS" : "COMPLETED";
        return new Response(JSON.stringify({ status }), { status: 200 });
      }
      if (u === RESPONSE_URL) {
        return new Response(JSON.stringify({ images: [{ url: "https://x.test/out.png" }] }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const { requestId, result } = await submitAndWait({
      model: "fal-ai/flux/schnell",
      input: { prompt: "x" },
      logger: noopLogger,
      pollIntervalMs: 5,
    });

    expect(requestId).toBe("req-1");
    expect(result).toEqual({ images: [{ url: "https://x.test/out.png" }] });
    expect(statusCalls).toBeGreaterThanOrEqual(2);
    // Never hits a reconstructed full-endpoint status/result URL.
    expect(seenUrls.some((u) => u.includes("/fal-ai/flux/schnell/requests/"))).toBe(false);
  });

  it("retries a transient 5xx error while polling, then succeeds", async () => {
    let statusCalls = 0;
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/fal-ai/flux/schnell")) {
        return new Response(
          JSON.stringify({
            request_id: "req-1",
            status_url: STATUS_URL,
            response_url: RESPONSE_URL,
          }),
          { status: 200 },
        );
      }
      if (u === STATUS_URL) {
        statusCalls++;
        if (statusCalls === 1) return new Response("Server Error", { status: 503 });
        return new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 });
      }
      if (u === RESPONSE_URL) {
        return new Response(JSON.stringify({ images: [{ url: "https://x.test/out.png" }] }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const { requestId } = await submitAndWait({
      model: "fal-ai/flux/schnell",
      input: { prompt: "x" },
      logger: noopLogger,
      pollIntervalMs: 5,
    });
    expect(requestId).toBe("req-1");
    expect(statusCalls).toBe(2);
  });

  it("does not retry a non-transient error (4xx) and includes the request id", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/fal-ai/flux/schnell")) {
        return new Response(
          JSON.stringify({
            request_id: "req-1",
            status_url: STATUS_URL,
            response_url: RESPONSE_URL,
          }),
          { status: 200 },
        );
      }
      if (u === STATUS_URL) {
        return new Response("Unauthorized", { status: 401 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    await expect(
      submitAndWait({
        model: "fal-ai/flux/schnell",
        input: { prompt: "x" },
        logger: noopLogger,
        pollIntervalMs: 5,
      }),
    ).rejects.toThrow(/req-1/);
  });

  it("times out by a real deadline and includes the request id + resume hint", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/fal-ai/flux/schnell")) {
        return new Response(
          JSON.stringify({
            request_id: "req-1",
            status_url: STATUS_URL,
            response_url: RESPONSE_URL,
          }),
          { status: 200 },
        );
      }
      if (u === STATUS_URL) {
        return new Response(JSON.stringify({ status: "IN_PROGRESS" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    await expect(
      submitAndWait({
        model: "fal-ai/flux/schnell",
        input: { prompt: "x" },
        logger: noopLogger,
        pollIntervalMs: 5,
        waitTimeoutMs: 20,
      }),
    ).rejects.toThrow(/req-1.*multix fal status|multix fal result/s);
  });

  it("wraps a result-fetch failure with the request id", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/fal-ai/flux/schnell")) {
        return new Response(
          JSON.stringify({
            request_id: "req-1",
            status_url: STATUS_URL,
            response_url: RESPONSE_URL,
          }),
          { status: 200 },
        );
      }
      if (u === STATUS_URL) {
        return new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 });
      }
      if (u === RESPONSE_URL) {
        return new Response("Internal Server Error", { status: 500 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    await expect(
      submitAndWait({
        model: "fal-ai/flux/schnell",
        input: { prompt: "x" },
        logger: noopLogger,
        pollIntervalMs: 5,
      }),
    ).rejects.toThrow(/req-1/);
  });
});

describe("downloadResultMedia", () => {
  const originalFetch = globalThis.fetch;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fal-dl-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes the partial file when the download stream fails mid-transfer", async () => {
    globalThis.fetch = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.error(new Error("connection reset"));
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;

    const saved = await downloadResultMedia(
      ["https://x.test/broken.png"],
      tmpDir,
      "req-1",
      noopLogger,
    );

    expect(saved).toEqual([]);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it("removes no file (none was created) when the download 404s outright", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("Not Found", { status: 404 }),
    ) as unknown as typeof fetch;

    const saved = await downloadResultMedia(
      ["https://x.test/missing.png"],
      tmpDir,
      "req-1",
      noopLogger,
    );

    expect(saved).toEqual([]);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it("saves successful downloads and skips failed ones", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      if (String(url).includes("good")) {
        return new Response("bytes", { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    const saved = await downloadResultMedia(
      ["https://x.test/good.png", "https://x.test/bad.png"],
      tmpDir,
      "req-1",
      noopLogger,
    );

    expect(saved.length).toBe(1);
    expect(fs.readdirSync(tmpDir).length).toBe(1);
  });
});
