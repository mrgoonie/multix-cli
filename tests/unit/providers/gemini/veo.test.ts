import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import { HttpError, ProviderError, ValidationError } from "../../../../src/core/errors.js";
import { createLogger } from "../../../../src/core/logger.js";
import { _resetGeminiKeyCooldowns } from "../../../../src/providers/gemini/key-pool.js";
import {
  buildVeoRequest,
  downloadVeoVideo,
  extractVeoVideoUri,
  runVeo,
  veoFramesFromPaths,
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

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-veo-"));
  calls = [];
  _resetGeminiKeyCooldowns();
  // Mutate process.env in place (never replace it) and restore afterwards.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GEMINI_API_KEY")) {
      savedEnv[k] = process.env[k];
      Reflect.deleteProperty(process.env, k);
    }
  }
  process.env.GEMINI_API_KEY = KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GEMINI_API_KEY")) Reflect.deleteProperty(process.env, k);
  }
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
});

describe("buildVeoRequest", () => {
  it("uses the predictLongRunning instances/parameters shape", () => {
    const image = { bytesBase64Encoded: "AAA", mimeType: "image/png" };
    const lastFrame = { bytesBase64Encoded: "BBB", mimeType: "image/jpeg" };
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
  it("reads images as bytesBase64Encoded with the right mime type", () => {
    const file = path.join(tmp, "a.png");
    fs.writeFileSync(file, Buffer.from([1, 2, 3]));
    expect(veoImageFromFile(file)).toEqual({ bytesBase64Encoded: "AQID", mimeType: "image/png" });
  });

  it("keeps the JPEG fallback for unknown extensions", () => {
    const file = path.join(tmp, "frame");
    fs.writeFileSync(file, "x");
    expect(veoImageFromFile(file).mimeType).toBe("image/jpeg");
  });

  it("rejects missing files and non-images", () => {
    expect(() => veoImageFromFile(path.join(tmp, "nope.png"))).toThrow(ValidationError);
    const pdf = path.join(tmp, "doc.pdf");
    fs.writeFileSync(pdf, "x");
    expect(() => veoImageFromFile(pdf)).toThrow(ValidationError);
    const gif = path.join(tmp, "a.gif");
    fs.writeFileSync(gif, "x");
    expect(() => veoImageFromFile(gif)).toThrow(/JPEG, PNG or WebP/);
  });
});

describe("veoFramesFromPaths", () => {
  it("maps the first image to the opening frame and the second to the closing frame", () => {
    const a = path.join(tmp, "a.png");
    const b = path.join(tmp, "b.jpg");
    fs.writeFileSync(a, "A");
    fs.writeFileSync(b, "B");
    const frames = veoFramesFromPaths([a, b]);
    expect(frames.image?.mimeType).toBe("image/png");
    expect(frames.lastFrame?.mimeType).toBe("image/jpeg");
    expect(veoFramesFromPaths([a]).lastFrame).toBeUndefined();
    expect(veoFramesFromPaths()).toEqual({ image: undefined, lastFrame: undefined });
  });

  it("rejects more than two images instead of silently dropping them", () => {
    expect(() => veoFramesFromPaths(["a", "b", "c"])).toThrow(/at most two/);
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

  it("throws when a polled operation finishes with an error", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ name: "op", done: true, error: { message: "blocked" } }), {
          status: 200,
        }),
    );
    await expect(
      waitForVeo(KEY, { name: "op" }, logger, { sleep: async () => {} }),
    ).rejects.toThrow(/Veo error: .*blocked/);
  });

  it("times out with the operation name", async () => {
    stubFetch(() => new Response(JSON.stringify({ name: "op-1", done: false }), { status: 200 }));
    await expect(
      waitForVeo(KEY, { name: "op-1" }, logger, { timeoutMs: 1, sleep: async () => {} }),
    ).rejects.toSatisfy((e: unknown) => e instanceof PollTimeoutError && /op-1/.test(String(e)));
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

  it("surfaces submit HTTP failures without leaking the key", async () => {
    stubFetch((call) => new Response(`not found ${call.url}`, { status: 404 }));
    const err = await runVeo(
      "veo-x",
      { prompt: "p", aspectRatio: "16:9", resolution: "720p" },
      path.join(tmp, "v.mp4"),
      logger,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(404);
    expect(String(err.message)).not.toContain(KEY);
  });

  it("rotates keys on a submit 429, then polls and downloads with the accepting key", async () => {
    process.env.GEMINI_API_KEY_2 = "second-gemini-key-00";
    let polls = 0;
    stubFetch((call) => {
      if (call.method === "POST") {
        if (call.headers["x-goog-api-key"] === KEY) {
          return new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}', { status: 429 });
        }
        return new Response(JSON.stringify({ name: "op-2", done: false }), { status: 200 });
      }
      if (call.url.endsWith("/op-2")) {
        polls++;
        return new Response(
          JSON.stringify({
            name: "op-2",
            done: true,
            response: {
              generateVideoResponse: { generatedSamples: [{ video: { uri: VIDEO_URI } }] },
            },
          }),
          { status: 200 },
        );
      }
      return new Response("MP4", { status: 200 });
    });
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1_000 });
    try {
      await runVeo(
        "veo-x",
        { prompt: "p", aspectRatio: "16:9", resolution: "720p" },
        path.join(tmp, "v.mp4"),
        logger,
      );
    } finally {
      vi.useRealTimers();
    }
    const keysUsed = calls.map((c) => `${c.method}:${c.headers["x-goog-api-key"] ?? "-"}`);
    expect(keysUsed).toEqual([
      `POST:${KEY}`,
      "POST:second-gemini-key-00",
      "GET:second-gemini-key-00",
      "GET:second-gemini-key-00",
    ]);
    expect(polls).toBe(1);
  }, 30_000);

  it("never resubmits when the download is rate-limited", async () => {
    process.env.GEMINI_API_KEY_2 = "second-gemini-key-00";
    stubFetch((call) => {
      if (call.method === "POST") {
        return new Response(
          JSON.stringify({
            name: "op",
            done: true,
            response: { generatedVideos: [{ video: { uri: VIDEO_URI } }] },
          }),
          { status: 200 },
        );
      }
      return new Response("slow down", { status: 429 });
    });
    await expect(
      runVeo(
        "veo-x",
        { prompt: "p", aspectRatio: "16:9", resolution: "720p" },
        path.join(tmp, "v.mp4"),
        logger,
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("strips a models/ prefix from the model id", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            name: "op",
            done: true,
            response: { generatedVideos: [{ video: { uri: VIDEO_URI } }] },
          }),
          { status: 200 },
        ),
    );
    await runVeo(
      "models/veo-3.1-generate-preview",
      { prompt: "p", aspectRatio: "16:9", resolution: "720p" },
      path.join(tmp, "v.mp4"),
      logger,
    );
    expect(calls[0]?.url).toContain("/v1beta/models/veo-3.1-generate-preview:predictLongRunning");
  });

  it("reports an unexpected response structure", async () => {
    stubFetch(
      () => new Response(JSON.stringify({ name: "op", done: true, response: {} }), { status: 200 }),
    );
    await expect(
      runVeo(
        "veo-x",
        { prompt: "p", aspectRatio: "16:9", resolution: "720p" },
        path.join(tmp, "v.mp4"),
        logger,
      ),
    ).rejects.toThrow(/Unexpected Veo response/);
  });
});

describe("downloadVeoVideo", () => {
  it("only sends the API key to the Gemini API host", async () => {
    stubFetch(() => new Response("X", { status: 200 }));
    await downloadVeoVideo(KEY, "https://storage.example.com/v.mp4", path.join(tmp, "a.mp4"));
    expect(calls[0]?.headers["x-goog-api-key"]).toBeUndefined();
    await downloadVeoVideo(KEY, VIDEO_URI, path.join(tmp, "b.mp4"));
    expect(calls[1]?.headers["x-goog-api-key"]).toBe(KEY);
  });

  it.each([
    ["a non-Files path", "https://generativelanguage.googleapis.com/v1beta/models/veo:generate"],
    ["a nested Files path", "https://generativelanguage.googleapis.com/v1beta/files/abc/x"],
    ["a non-default port", "https://generativelanguage.googleapis.com:8443/v1beta/files/abc"],
    ["plain http", "http://generativelanguage.googleapis.com/v1beta/files/abc:download"],
    ["a dot-segment path", "https://generativelanguage.googleapis.com/v1beta/files/../models/x"],
    ["an encoded slash", "https://generativelanguage.googleapis.com/v1beta/files/abc%2F..%2Fx"],
  ])("does not send the API key to %s on the Gemini API host", async (_, uri) => {
    stubFetch(() => new Response("X", { status: 200 }));
    await downloadVeoVideo(KEY, uri, path.join(tmp, "d.mp4"));
    expect(calls[0]?.headers["x-goog-api-key"]).toBeUndefined();
  });

  it.each([
    ["without :download", "https://generativelanguage.googleapis.com/v1beta/files/abc"],
    ["with the default port", "https://generativelanguage.googleapis.com:443/v1beta/files/abc"],
  ])("sends the API key to a Files API resource URI %s", async (_, uri) => {
    stubFetch(() => new Response("X", { status: 200 }));
    await downloadVeoVideo(KEY, uri, path.join(tmp, "e.mp4"));
    expect(calls[0]?.headers["x-goog-api-key"]).toBe(KEY);
  });

  it("rejects an invalid video URI", async () => {
    await expect(downloadVeoVideo(KEY, "not a url", path.join(tmp, "f.mp4"))).rejects.toThrow(
      "invalid video URI",
    );
  });

  it("surfaces failed downloads", async () => {
    stubFetch(() => new Response("nope", { status: 403 }));
    await expect(downloadVeoVideo(KEY, VIDEO_URI, path.join(tmp, "c.mp4"))).rejects.toMatchObject({
      status: 403,
    });
  });
});
