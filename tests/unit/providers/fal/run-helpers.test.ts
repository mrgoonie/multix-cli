import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, ValidationError } from "../../../../src/core/errors.js";
import {
  audioProblem,
  chooseMediaExt,
  downloadResultMedia,
  extractMediaRefs,
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

  /** Fetch mock whose submit returns the given follow-up URLs; records every keyed request. */
  function mockSubmit(statusUrl: string, responseUrl: string) {
    const calls: { url: string; auth: string | undefined }[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      calls.push({ url: u, auth });
      if (u.endsWith("/fal-ai/flux/schnell")) {
        return new Response(
          JSON.stringify({ request_id: "req-1", status_url: statusUrl, response_url: responseUrl }),
          { status: 200 },
        );
      }
      if (u === statusUrl) {
        return new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 });
      }
      if (u === responseUrl) {
        return new Response(JSON.stringify({ images: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;
    return calls;
  }

  const run = () =>
    submitAndWait({
      model: "fal-ai/flux/schnell",
      input: { prompt: "x" },
      logger: noopLogger,
      pollIntervalMs: 5,
    });

  it("polls a trusted status_url/response_url with the key", async () => {
    const calls = mockSubmit(STATUS_URL, RESPONSE_URL);
    await run();
    expect(calls.map((c) => c.url)).toEqual([
      "https://queue.fal.run/fal-ai/flux/schnell",
      STATUS_URL,
      RESPONSE_URL,
    ]);
    expect(calls.every((c) => c.auth === "Key test-key")).toBe(true);
  });

  it("refuses a foreign status_url with a ProviderError and sends it nothing", async () => {
    const calls = mockSubmit("https://evil.example/status?sig=secret", RESPONSE_URL);
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toContain("evil.example");
    expect((err as Error).message).not.toContain("secret");
    expect(calls.some((c) => c.url.includes("evil.example"))).toBe(false);
    expect(calls).toHaveLength(1); // the submit only
  });

  it("refuses a foreign response_url before polling", async () => {
    const calls = mockSubmit(STATUS_URL, "https://evil.example/result");
    await expect(run()).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(1);
  });

  it("refuses a plain-http status_url on a public host", async () => {
    const calls = mockSubmit(
      "http://queue.fal.run/fal-ai/flux/requests/req-1/status",
      RESPONSE_URL,
    );
    await expect(run()).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(1);
  });

  it.each(["status_url", "response_url"])(
    "raises a clear ProviderError when the submit response is missing %s",
    async (field) => {
      const submitBody: Record<string, string> = {
        request_id: "req-1",
        status_url: STATUS_URL,
        response_url: RESPONSE_URL,
      };
      Reflect.deleteProperty(submitBody, field);
      const fetchMock = vi.fn(
        async () => new Response(JSON.stringify(submitBody), { status: 200 }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as Error).message).toBe(`fal submit response is missing ${field}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  describe("with a custom FAL_BASE_URL", () => {
    const originalBase = process.env.FAL_BASE_URL;
    afterEach(() => {
      if (originalBase === undefined) Reflect.deleteProperty(process.env, "FAL_BASE_URL");
      else process.env.FAL_BASE_URL = originalBase;
    });

    it("allows http loopback follow-up URLs on the base host", async () => {
      process.env.FAL_BASE_URL = "http://127.0.0.1:8787";
      const calls = mockSubmit(
        "http://127.0.0.1:8787/fal-ai/flux/requests/req-1/status",
        "http://127.0.0.1:8787/fal-ai/flux/requests/req-1",
      );
      await run();
      expect(calls).toHaveLength(3);
    });

    it("refuses an http non-loopback FAL_BASE_URL before any request (base-URL trust rules)", async () => {
      process.env.FAL_BASE_URL = "http://fal-proxy.internal:8080";
      const calls = mockSubmit(STATUS_URL, RESPONSE_URL);
      await expect(run()).rejects.toThrow(/FAL_BASE_URL must use https/);
      expect(calls).toHaveLength(0);
    });

    it.each(["https://10.0.0.5", "http://[::1]:8787"])(
      "allows follow-up URLs on the %s base origin and refuses a foreign host",
      async (base) => {
        process.env.FAL_BASE_URL = base;
        const ok = mockSubmit(
          `${base}/fal-ai/flux/requests/req-1/status`,
          `${base}/fal-ai/flux/requests/req-1`,
        );
        await run();
        expect(ok).toHaveLength(3);

        const refused = mockSubmit("https://evil.example/status", `${base}/r`);
        await expect(run()).rejects.toBeInstanceOf(ProviderError);
        expect(refused).toHaveLength(1);
      },
    );

    it("still refuses http loopback when the base URL is the public fal host", async () => {
      process.env.FAL_BASE_URL = "https://queue.fal.run";
      const calls = mockSubmit("http://127.0.0.1:8787/status", RESPONSE_URL);
      await expect(run()).rejects.toBeInstanceOf(ProviderError);
      expect(calls).toHaveLength(1);
    });
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

/** Leading bytes of real files of each format. */
const WAV = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVEfmt "),
  Buffer.alloc(32, 1),
]);
const MP3_ID3 = Buffer.concat([
  Buffer.from("ID3"),
  Buffer.from([4, 0, 0, 0, 0, 0, 0]),
  Buffer.alloc(32, 7),
]);
const MP3_FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(32, 3)]);
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(32, 2)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32),
]);
/** Raw 16-bit PCM: no header. These samples happen to look like an MPEG frame sync. */
const PCM = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x01, 0x02, 0x03, 0x04]);

describe("extractMediaRefs", () => {
  it("keeps fal's content_type and file_name next to each URL", () => {
    const result = {
      audio: {
        url: "https://v3b.fal.media/files/b/x/abc",
        content_type: "audio/wav",
        file_name: "gemini_tts_output.wav",
        file_size: 104036,
      },
    };
    expect(extractMediaRefs(result)).toEqual([
      {
        url: "https://v3b.fal.media/files/b/x/abc",
        contentType: "audio/wav",
        fileName: "gemini_tts_output.wav",
      },
    ]);
  });

  it("finds refs in unknown shapes through the generic fallback", () => {
    const result = { output: { clips: [{ url: "https://x.test/1", content_type: "audio/mpeg" }] } };
    expect(extractMediaRefs(result)).toEqual([
      { url: "https://x.test/1", contentType: "audio/mpeg" },
    ]);
  });
});

describe("chooseMediaExt", () => {
  it("names the file by its bytes when the URL has no extension", () => {
    expect(chooseMediaExt(WAV, { url: "https://x.test/files/abc" })).toBe(".wav");
    expect(chooseMediaExt(MP3_ID3, { url: "https://x.test/files/abc?sig=1" })).toBe(".mp3");
    expect(chooseMediaExt(OGG, { url: "https://x.test/files/abc" })).toBe(".ogg");
  });

  it("trusts the bytes over a file name or MIME type that says otherwise", () => {
    expect(
      chooseMediaExt(WAV, {
        url: "https://x.test/a.mp3",
        contentType: "audio/mpeg",
        fileName: "a.mp3",
      }),
    ).toBe(".wav");
    expect(chooseMediaExt(MP3_FRAME, { url: "https://x.test/a.wav" }, "audio/wav")).toBe(".mp3");
  });

  it("keeps a declared raw format whose bytes carry no signature", () => {
    expect(
      chooseMediaExt(PCM, {
        url: "https://x.test/files/w-YUnp_output.pcm",
        contentType: "application/octet-stream",
        fileName: "output.pcm",
      }),
    ).toBe(".pcm");
    expect(chooseMediaExt(PCM, { url: "https://x.test/f", contentType: "audio/pcm" })).toBe(".pcm");
  });

  it("falls back to content_type, file_name, URL, response header, then .bin", () => {
    const blank = Buffer.alloc(16);
    expect(chooseMediaExt(blank, { url: "https://x.test/f", contentType: "audio/flac" })).toBe(
      ".flac",
    );
    expect(chooseMediaExt(blank, { url: "https://x.test/f", fileName: "speech.OPUS" })).toBe(
      ".opus",
    );
    expect(chooseMediaExt(blank, { url: "https://x.test/f.m4a" })).toBe(".m4a");
    expect(chooseMediaExt(blank, { url: "https://x.test/f" }, "audio/ogg; codecs=opus")).toBe(
      ".ogg",
    );
    expect(chooseMediaExt(blank, { url: "https://x.test/f" })).toBe(".bin");
    // Text bytes never decide the extension (an error page is not a .txt result).
    expect(chooseMediaExt(Buffer.from("<html>"), { url: "https://x.test/f.mp4" })).toBe(".mp4");
  });
});

describe("audioProblem", () => {
  it("accepts audio containers and raw formats", () => {
    expect(audioProblem(WAV, 100, ".wav")).toBeUndefined();
    expect(audioProblem(PCM, 8, ".pcm")).toBeUndefined();
  });

  it("refuses empty files, text bodies and other media", () => {
    expect(audioProblem(Buffer.alloc(0), 0, ".mp3")).toMatch(/empty/);
    expect(audioProblem(Buffer.from('{"detail":"quota"}'), 18, ".mp3")).toMatch(/text, not audio/);
    expect(audioProblem(PNG, 40, ".png")).toMatch(/expected audio but the file is png/);
  });
});

describe("downloadResultMedia with expect: audio", () => {
  const originalFetch = globalThis.fetch;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fal-dl-audio-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves good audio under the right extension and removes blank or bad files", async () => {
    const bodies: Record<string, Uint8Array> = {
      "https://x.test/good": WAV,
      "https://x.test/blank.mp3": new Uint8Array(0),
      "https://x.test/bad.mp3": Buffer.from("<html>Access denied</html>"),
    };
    globalThis.fetch = vi.fn(
      async (url: string | URL) => new Response(bodies[String(url)], { status: 200 }),
    ) as unknown as typeof fetch;
    const problems: string[] = [];
    const saved = await downloadResultMedia(
      ["https://x.test/good", "https://x.test/blank.mp3", "https://x.test/bad.mp3"],
      tmpDir,
      "req-a",
      noopLogger,
      { expect: "audio", problems },
    );
    expect(saved.map((f) => path.basename(f))).toEqual(["fal-req-a-01.wav"]);
    expect(fs.readdirSync(tmpDir)).toEqual(["fal-req-a-01.wav"]);
    expect(problems).toEqual([
      expect.stringMatching(/blank\.mp3: the file is empty/),
      expect.stringMatching(/bad\.mp3: the body is text/),
    ]);
  });

  it("without expect keeps any bytes, named by the URL as before", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("bytes", { status: 200 }),
    ) as unknown as typeof fetch;
    const saved = await downloadResultMedia(["https://x.test/a.mp4"], tmpDir, "req-b", noopLogger);
    expect(saved.map((f) => path.basename(f))).toEqual(["fal-req-b-01.mp4"]);
  });
});
