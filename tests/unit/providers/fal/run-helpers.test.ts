import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import {
  extractMediaUrls,
  parseInputArg,
  submitAndWait,
} from "../../../../src/providers/fal/run-helpers.js";

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
  it("collects url fields recursively", () => {
    const result = {
      images: [{ url: "https://x.test/a.png" }, { url: "https://x.test/b.png" }],
      video: { url: "https://x.test/c.mp4" },
      seed: 42,
    };
    expect(extractMediaUrls(result).sort()).toEqual(
      ["https://x.test/a.png", "https://x.test/b.png", "https://x.test/c.mp4"].sort(),
    );
  });

  it("ignores non-http url values", () => {
    expect(extractMediaUrls({ url: "data:image/png;base64,xxx" })).toEqual([]);
  });

  it("returns empty array for primitives", () => {
    expect(extractMediaUrls("hello")).toEqual([]);
    expect(extractMediaUrls(null)).toEqual([]);
    expect(extractMediaUrls(42)).toEqual([]);
  });
});

describe("submitAndWait", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FAL_KEY;

  beforeEach(() => {
    process.env.FAL_KEY = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) process.env.FAL_KEY = undefined;
    else process.env.FAL_KEY = originalKey;
  });

  it("submits, polls until COMPLETED, then fetches the result", async () => {
    let statusCalls = 0;
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/fal-ai/flux/schnell")) {
        return new Response(
          JSON.stringify({
            request_id: "req-1",
            status_url: "https://queue.fal.run/fal-ai/flux/schnell/requests/req-1/status",
            response_url: "https://queue.fal.run/fal-ai/flux/schnell/requests/req-1",
          }),
          { status: 200 },
        );
      }
      if (u.endsWith("/status")) {
        statusCalls++;
        const status = statusCalls < 2 ? "IN_PROGRESS" : "COMPLETED";
        return new Response(JSON.stringify({ status }), { status: 200 });
      }
      if (u.endsWith("/requests/req-1")) {
        return new Response(JSON.stringify({ images: [{ url: "https://x.test/out.png" }] }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const logger = {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      header: vi.fn(),
    };
    const { requestId, result } = await submitAndWait({
      model: "fal-ai/flux/schnell",
      input: { prompt: "x" },
      logger,
      pollIntervalMs: 5,
    });

    expect(requestId).toBe("req-1");
    expect(result).toEqual({ images: [{ url: "https://x.test/out.png" }] });
    expect(statusCalls).toBeGreaterThanOrEqual(2);
  });
});
