import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, ValidationError } from "../../../../src/core/errors.js";
import { createLogger } from "../../../../src/core/logger.js";
import {
  buildVeoRequest,
  extractVeoVideoUri,
  runVeo,
  veoImageFromFile,
  waitForVeo,
} from "../../../../src/providers/gemini/veo.js";

const logger = createLogger({ verbose: false });
const KEY = "test-gemini-key-0000";
const VIDEO_URI = "https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

let tmp: string;
let calls: Call[];

function stubFetch(handler: (call: Call) => Response): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-veo-"));
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("buildVeoRequest", () => {
  it("uses the predictLongRunning instances/parameters shape", () => {
    const image = { inlineData: { mimeType: "image/png", data: "AAA" } };
    const lastFrame = { inlineData: { mimeType: "image/jpeg", data: "BBB" } };
    expect(
      buildVeoRequest({
        prompt: "a cat",
        image,
        lastFrame,
        aspectRatio: "16:9",
        resolution: "720p",
      }),
    ).toEqual({
      instances: [{ prompt: "a cat", image, lastFrame }],
      parameters: { aspectRatio: "16:9", resolution: "720p" },
    });
  });

  it("omits absent images", () => {
    const body = buildVeoRequest({ prompt: "x", aspectRatio: "9:16", resolution: "1080p" });
    expect(body.instances).toEqual([{ prompt: "x" }]);
  });
});

describe("veoImageFromFile", () => {
  it("reads images as base64 inlineData with the right mime type", () => {
    const file = path.join(tmp, "a.png");
    fs.writeFileSync(file, Buffer.from([1, 2, 3]));
    expect(veoImageFromFile(file)).toEqual({
      inlineData: { mimeType: "image/png", data: "AQID" },
    });
  });

  it("keeps the JPEG fallback for unknown extensions", () => {
    const file = path.join(tmp, "frame");
    fs.writeFileSync(file, "x");
    expect(veoImageFromFile(file).inlineData.mimeType).toBe("image/jpeg");
  });

  it("rejects missing files and non-images", () => {
    expect(() => veoImageFromFile(path.join(tmp, "nope.png"))).toThrow(ValidationError);
    const pdf = path.join(tmp, "doc.pdf");
    fs.writeFileSync(pdf, "x");
    expect(() => veoImageFromFile(pdf)).toThrow(ValidationError);
  });
});

describe("extractVeoVideoUri", () => {
  it("reads the REST generateVideoResponse path", () => {
    expect(
      extractVeoVideoUri({
        name: "op",
        response: {
          generateVideoResponse: { generatedSamples: [{ video: { uri: VIDEO_URI } }] },
        },
      }),
    ).toBe(VIDEO_URI);
  });

  it("falls back to SDK-style shapes", () => {
    expect(
      extractVeoVideoUri({
        name: "op",
        response: { generatedVideos: [{ video: { uri: "u2" } }] },
      }),
    ).toBe("u2");
    expect(extractVeoVideoUri({ name: "op" })).toBeUndefined();
  });
});

describe("waitForVeo", () => {
  it("polls the operation with the API key header until done", async () => {
    let polls = 0;
    stubFetch(() => {
      polls++;
      const done = polls >= 2;
      return new Response(JSON.stringify({ name: "models/veo/operations/1", done }), {
        status: 200,
      });
    });
    const op = await waitForVeo(KEY, { name: "models/veo/operations/1" }, logger, {
      sleep: async () => {},
    });
    expect(op.done).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/veo/operations/1",
    );
    expect(calls[0]?.headers["x-goog-api-key"]).toBe(KEY);
  });

  it("throws on operation errors", async () => {
    await expect(
      waitForVeo(KEY, { name: "op", done: true, error: { code: 400, message: "bad" } }, logger),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("runVeo", () => {
  it("submits to predictLongRunning and downloads with the API key", async () => {
    stubFetch((call) => {
      if (call.method === "POST") {
        return new Response(
          JSON.stringify({
            name: "models/veo-3.1-generate-preview/operations/xyz",
            done: true,
            response: {
              generateVideoResponse: { generatedSamples: [{ video: { uri: VIDEO_URI } }] },
            },
          }),
          { status: 200 },
        );
      }
      return new Response("MP4DATA", { status: 200 });
    });

    const dest = path.join(tmp, "out", "v.mp4");
    await runVeo(
      KEY,
      "veo-3.1-generate-preview",
      { prompt: "a cat", aspectRatio: "16:9", resolution: "720p" },
      dest,
      logger,
    );

    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning",
    );
    expect(calls[0]?.url).not.toContain("key=");
    expect(calls[0]?.headers["x-goog-api-key"]).toBe(KEY);
    expect(calls[0]?.body).toEqual({
      instances: [{ prompt: "a cat" }],
      parameters: { aspectRatio: "16:9", resolution: "720p" },
    });
    expect(calls[1]?.url).toBe(VIDEO_URI);
    expect(calls[1]?.headers["x-goog-api-key"]).toBe(KEY);
    expect(fs.readFileSync(dest, "utf8")).toBe("MP4DATA");
  });

  it("wraps submit failures without leaking the key", async () => {
    stubFetch(() => new Response("not found", { status: 404 }));
    const err = await runVeo(
      KEY,
      "veo-x",
      { prompt: "p", aspectRatio: "16:9", resolution: "720p" },
      path.join(tmp, "v.mp4"),
      logger,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(String(err.message)).toContain("Veo submit failed");
    expect(String(err.message)).not.toContain(KEY);
  });

  it("reports an unexpected response structure", async () => {
    stubFetch(
      () => new Response(JSON.stringify({ name: "op", done: true, response: {} }), { status: 200 }),
    );
    await expect(
      runVeo(
        KEY,
        "veo-x",
        { prompt: "p", aspectRatio: "16:9", resolution: "720p" },
        path.join(tmp, "v.mp4"),
        logger,
      ),
    ).rejects.toThrow(/Unexpected Veo response/);
  });
});
