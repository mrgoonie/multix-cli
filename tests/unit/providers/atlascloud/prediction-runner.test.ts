import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetEnvLoader } from "../../../../src/core/env-loader.js";
import { ConfigError, ProviderError, ValidationError } from "../../../../src/core/errors.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { AtlasPredictionFailedError } from "../../../../src/providers/atlascloud/client.js";
import {
  atlasDefaultModel,
  createAtlasClientFromEnv,
  resolveMediaRef,
} from "../../../../src/providers/atlascloud/commands/env.js";
import {
  assertEndpoint,
  availableOutputPath,
  executePrediction,
  loadModelSpec,
  planOutputPaths,
} from "../../../../src/providers/atlascloud/commands/prediction-runner.js";
import { parseMediaKind } from "../../../../src/providers/atlascloud/commands/run.js";
import { parseModelSpec } from "../../../../src/providers/atlascloud/model-input.js";
import {
  BASE,
  FLUX_SCHNELL_SCHEMA,
  SEEDANCE_T2V_SCHEMA,
  TEST_KEY,
  catalog,
  createFakeAtlas,
  envelope,
  prediction,
} from "./fake-atlas.js";

const logger = {
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  header: vi.fn(),
};

let tmp: string;
let stdout: string[];
const originalEnv = { ...process.env };

/** Stub the global fetch used by downloadFile; returns the bytes per URL. */
function stubDownloads(files: Record<string, string | number>) {
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(url);
    const entry = files[url];
    if (entry === undefined) throw new Error(`unexpected download ${url}`);
    if (typeof entry === "number") return new Response("nope", { status: entry });
    return new Response(entry, { status: 200 });
  });
  return fetched;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-run-"));
  process.env.MULTIX_OUTPUT_DIR = tmp;
  _resetOutputDir();
  stdout = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    stdout.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("executePrediction (mocked submit -> poll -> saved output)", () => {
  it("image: black-forest-labs/flux-schnell saves atlas-<id>-01.jpg", async () => {
    const out = "https://atlas-media.test/history/47e7acf05d74-d58.jpeg";
    const { client, calls } = createFakeAtlas({
      "POST /model/generateImage": { body: prediction("47e7acf05d7449c1", "processing") },
      "GET /model/prediction/47e7acf05d7449c1": [
        { body: prediction("47e7acf05d7449c1", "processing") },
        { body: prediction("47e7acf05d7449c1", "completed", { outputs: [out], price: "0.003" }) },
      ],
    });
    stubDownloads({ [out]: "JPEGBYTES" });

    const res = await executePrediction({
      client,
      logger,
      kind: "image",
      model: "black-forest-labs/flux-schnell",
      body: { prompt: "a red fox" },
      opts: { imageFormat: "original" },
      hint: "image",
      defaultWaitTimeoutMs: 60_000,
      pollIntervalMs: 1,
    });

    expect(calls[0]?.body).toEqual({
      prompt: "a red fox",
      model: "black-forest-labs/flux-schnell",
    });
    expect(calls[0]?.url).toBe(`${BASE}/model/generateImage`);
    const expected = path.join(tmp, "atlas-47e7acf0-01.jpg");
    expect(res.files).toEqual([expected]);
    expect(fs.readFileSync(expected, "utf8")).toBe("JPEGBYTES");
  });

  it("video: bytedance/seedance-v1-pro-fast/text-to-video saves the MP4 to --output", async () => {
    const out = "https://atlas-media.test/v/vid1.mp4";
    const { client } = createFakeAtlas({
      "POST /model/generateVideo": { body: prediction("vid1", "processing") },
      "GET /model/prediction/vid1": { body: prediction("vid1", "completed", { outputs: [out] }) },
    });
    stubDownloads({ [out]: "MP4BYTES" });
    const dest = path.join(tmp, "clips", "waves.mp4");

    const res = await executePrediction({
      client,
      logger,
      kind: "video",
      model: "bytedance/seedance-v1-pro-fast/text-to-video",
      body: { prompt: "waves", duration: 5 },
      opts: { output: dest },
      hint: "video",
      defaultWaitTimeoutMs: 60_000,
      pollIntervalMs: 1,
    });
    expect(res.files).toEqual([dest]);
    expect(fs.readFileSync(dest, "utf8")).toBe("MP4BYTES");
  });

  it("multi-output: every output gets a numbered name", async () => {
    const urls = ["https://m.test/a.mp3", "https://m.test/b.mp3"];
    const { client } = createFakeAtlas({
      "POST /model/generateAudio": {
        body: prediction("song1234xyz", "completed", { outputs: urls }),
      },
    });
    stubDownloads({ [urls[0] as string]: "A", [urls[1] as string]: "B" });
    const res = await executePrediction({
      client,
      logger,
      kind: "audio",
      model: "suno/chirp-v5",
      body: { prompt: "summer road trip" },
      opts: {},
      hint: "audio",
      defaultWaitTimeoutMs: 60_000,
    });
    expect(res.files.map((f) => path.basename(f))).toEqual([
      "atlas-song1234-01.mp3",
      "atlas-song1234-02.mp3",
    ]);
  });

  it("text audio output (speech-to-text) is printed and saved, never downloaded", async () => {
    const { client } = createFakeAtlas({
      "POST /model/generateAudio": { body: prediction("stt1", "processing") },
      "GET /model/prediction/stt1": {
        body: prediction("stt1", "completed", { outputs: ["Thanks for joining the call today"] }),
      },
    });
    const fetched = stubDownloads({});
    const dest = path.join(tmp, "transcript.txt");
    const res = await executePrediction({
      client,
      logger,
      kind: "audio",
      model: "bytedance/seed-asr-2.0",
      body: { audio_url: "https://x.test/a.mp3" },
      opts: { output: dest },
      hint: "audio",
      defaultWaitTimeoutMs: 60_000,
      pollIntervalMs: 1,
    });
    expect(fetched).toEqual([]);
    expect(res.texts).toEqual(["Thanks for joining the call today"]);
    expect(stdout).toContain("Thanks for joining the call today");
    expect(fs.readFileSync(dest, "utf8").trim()).toBe("Thanks for joining the call today");
  });

  it("--async prints the id and a resume command without polling", async () => {
    const { client, calls } = createFakeAtlas({
      "POST /model/generateImage": { body: prediction("async01", "processing") },
    });
    const res = await executePrediction({
      client,
      logger,
      kind: "image",
      model: "m/x",
      body: { prompt: "x" },
      opts: { async: true },
      defaultWaitTimeoutMs: 60_000,
    });
    expect(res.files).toEqual([]);
    expect(stdout).toEqual(["async01"]);
    expect(calls).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("multix atlas status async01 --wait --download"),
    );
  });

  it("terminal failure throws (non-zero exit), even when reported as HTTP 500", async () => {
    const { client } = createFakeAtlas({
      "POST /model/generateVideo": { body: prediction("bad1", "processing") },
      "GET /model/prediction/bad1": {
        status: 500,
        body: { code: 500, data: { id: "bad1", status: "failed", error: "Insufficient balance" } },
      },
    });
    await expect(
      executePrediction({
        client,
        logger,
        kind: "video",
        model: "m/v",
        body: { prompt: "x" },
        opts: {},
        defaultWaitTimeoutMs: 60_000,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(AtlasPredictionFailedError);
  });

  it("an empty NSFW-flagged result is an error, not a silent success", async () => {
    const { client } = createFakeAtlas({
      "POST /model/generateImage": {
        body: prediction("nsfw1", "completed", { outputs: [], has_nsfw_contents: [true] }),
      },
    });
    await expect(
      executePrediction({
        client,
        logger,
        kind: "image",
        model: "m/x",
        body: { prompt: "x" },
        opts: {},
        defaultWaitTimeoutMs: 60_000,
      }),
    ).rejects.toThrow(/content safety/);
  });

  it("fails when no output downloads, without leaking the signed URL query", async () => {
    const url = "https://m.test/a.png?X-Signature=SECRET";
    const { client } = createFakeAtlas({
      "POST /model/generateImage": { body: prediction("dl1", "completed", { outputs: [url] }) },
    });
    stubDownloads({ [url]: 403 });
    await expect(
      executePrediction({
        client,
        logger,
        kind: "image",
        model: "m/x",
        body: { prompt: "x" },
        opts: {},
        defaultWaitTimeoutMs: 60_000,
      }),
    ).rejects.toThrow(ProviderError);
    const warned = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("?[redacted]");
    expect(warned).not.toContain("SECRET");
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("--no-download prints URLs instead of saving", async () => {
    const url = "https://m.test/a.png";
    const { client } = createFakeAtlas({
      "POST /model/generateImage": { body: prediction("nd1", "completed", { outputs: [url] }) },
    });
    const res = await executePrediction({
      client,
      logger,
      kind: "image",
      model: "m/x",
      body: { prompt: "x" },
      opts: { download: false },
      defaultWaitTimeoutMs: 60_000,
    });
    expect(res.files).toEqual([]);
    expect(stdout).toContain(url);
  });
});

describe("planOutputPaths", () => {
  const urls = ["https://m/a.png", "https://m/b"];
  it("uses the output dir and the hint for extensionless URLs", () => {
    const paths = planOutputPaths(urls, {
      predictionId: "abcdef123",
      outDir: () => tmp,
      hint: "image",
    });
    expect(paths).toEqual([
      path.join(tmp, "atlas-abcdef12-01.png"),
      path.join(tmp, "atlas-abcdef12-02.png"),
    ]);
  });

  it("treats an extensionless --output as a directory and a file path as a stem", () => {
    const dir = path.join(tmp, "out");
    expect(planOutputPaths(urls, { predictionId: "id1", outDir: () => tmp, output: dir })[0]).toBe(
      path.join(dir, "atlas-id1-01.png"),
    );
    expect(
      planOutputPaths(urls, { predictionId: "id1", outDir: () => tmp, output: "r.png" }),
    ).toEqual([path.resolve("r-01.png"), path.resolve("r-02.bin")]);
    expect(
      planOutputPaths(["https://m/a.mp4"], {
        predictionId: "id1",
        outDir: () => tmp,
        output: "v.mp4",
      }),
    ).toEqual([path.resolve("v.mp4")]);
  });
});

describe("schema guard", () => {
  it("rejects a model served by another endpoint with a helpful command", () => {
    const spec = parseModelSpec(
      "bytedance/seedance-v1-pro-fast/text-to-video",
      SEEDANCE_T2V_SCHEMA,
    );
    expect(() =>
      assertEndpoint(spec, "image", "bytedance/seedance-v1-pro-fast/text-to-video"),
    ).toThrow(/is a video model.*multix atlas video/);
    expect(() => assertEndpoint(undefined, "image", "x")).not.toThrow();
  });

  it("loadModelSpec warns and continues when the schema cannot be loaded", async () => {
    const { client } = createFakeAtlas({ "GET /models": { status: 503, body: {} } });
    expect(await loadModelSpec(client, "m/x", logger, undefined)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("without validation"));
  });

  it("loadModelSpec returns the spec, or skips with --no-validate", async () => {
    const { client, calls } = createFakeAtlas({
      "GET /models": {
        body: catalog([
          {
            model: "black-forest-labs/flux-schnell",
            type: "Image",
            schema: "https://s.test/f.json",
          },
        ]),
      },
      "GET /f.json": { body: FLUX_SCHNELL_SCHEMA },
    });
    expect(
      await loadModelSpec(client, "black-forest-labs/flux-schnell", logger, false),
    ).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(
      (await loadModelSpec(client, "black-forest-labs/flux-schnell", logger, true))?.endpoint,
    ).toBe("image");
  });

  it("parses --type", () => {
    expect(parseMediaKind("Video")).toBe("video");
    expect(parseMediaKind(undefined)).toBeUndefined();
    expect(() => parseMediaKind("3d")).toThrow(ValidationError);
  });
});

describe("references and env", () => {
  it("passes URLs through and uploads local files under their own name", async () => {
    let uploadedName: string | undefined;
    const { client } = createFakeAtlas({});
    const uploading = Object.assign(client, {
      uploadMedia: async (_b: Blob, name: string) => {
        uploadedName = name;
        return { url: "https://cdn.test/up/photo.png" };
      },
    });
    expect(await resolveMediaRef(uploading, "https://x.test/a.png", logger)).toBe(
      "https://x.test/a.png",
    );
    const local = path.join(tmp, "photo.png");
    fs.writeFileSync(local, "PNG");
    expect(await resolveMediaRef(uploading, local, logger)).toBe("https://cdn.test/up/photo.png");
    expect(uploadedName).toBe("photo.png");
    await expect(resolveMediaRef(uploading, path.join(tmp, "missing.png"), logger)).rejects.toThrow(
      ValidationError,
    );
  });

  it("uploads through POST /model/uploadMedia end to end", async () => {
    const { client, calls } = createFakeAtlas({
      "POST /model/uploadMedia": { body: envelope({ download_url: "https://cdn.test/u/a.wav" }) },
    });
    const local = path.join(tmp, "a.wav");
    fs.writeFileSync(local, "RIFF");
    expect(await resolveMediaRef(client, local, logger)).toBe("https://cdn.test/u/a.wav");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it("reads the key, base URL and model overrides from the environment", () => {
    _resetEnvLoader();
    Reflect.deleteProperty(process.env, "ATLASCLOUD_API_KEY");
    expect(() => createAtlasClientFromEnv()).toThrow(ConfigError);
    process.env.ATLASCLOUD_API_KEY = TEST_KEY;
    process.env.ATLASCLOUD_BASE_URL = "http://127.0.0.1:8787/api/v1";
    expect(createAtlasClientFromEnv().baseUrl).toBe("http://127.0.0.1:8787/api/v1");
    expect(atlasDefaultModel("video")).toBe("bytedance/seedance-v1-pro-fast/text-to-video");
    process.env.ATLASCLOUD_VIDEO_MODEL = "kwaivgi/kling-v2.6-pro/text-to-video";
    expect(atlasDefaultModel("video")).toBe("kwaivgi/kling-v2.6-pro/text-to-video");
  });

  it("requires https for ATLASCLOUD_BASE_URL, allowing http only on loopback", () => {
    _resetEnvLoader();
    process.env.ATLASCLOUD_API_KEY = TEST_KEY;
    for (const ok of [
      "https://proxy.example.com/api/v1",
      "http://localhost:8787/api/v1",
      "http://[::1]:8787/api/v1",
    ]) {
      process.env.ATLASCLOUD_BASE_URL = ok;
      expect(createAtlasClientFromEnv().baseUrl).toBe(ok);
    }
    for (const bad of ["http://mock.local/api/v1", "http://10.0.0.5/api/v1", "not a url"]) {
      process.env.ATLASCLOUD_BASE_URL = bad;
      expect(() => createAtlasClientFromEnv()).toThrow(ConfigError);
      expect(() => createAtlasClientFromEnv()).toThrow(/ATLASCLOUD_BASE_URL/);
    }
  });
});

describe("download hardening", () => {
  /** Run a prediction that completes immediately with `extra` (outputs, input...). */
  function runCompleted(id: string, extra: Record<string, unknown>, opts = {}) {
    const { client } = createFakeAtlas({
      "POST /model/generateVideo": { body: prediction(id, "completed", extra) },
    });
    return executePrediction({
      client,
      logger,
      kind: "video",
      model: "m/v",
      body: { prompt: "x" },
      opts: { imageFormat: "original", ...opts },
      hint: "video",
      defaultWaitTimeoutMs: 60_000,
    });
  }

  it("refuses http and private-address outputs without fetching them", async () => {
    const fetched = stubDownloads({});
    for (const url of [
      "http://m.test/a.mp4",
      "https://169.254.169.254/latest/meta-data.mp4",
      "https://[::1]/a.mp4",
      "https://localhost/a.mp4",
    ]) {
      await expect(runCompleted("unsafe01", { outputs: [url] })).rejects.toThrow(ProviderError);
    }
    expect(fetched).toEqual([]);
    const warned = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("only https:// URLs are allowed");
    expect(warned).toContain("local or private address");
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("refuses a redirect from https to http or to an internal address", async () => {
    const start = "https://m.test/a.mp4";
    for (const target of ["http://m.test/a.mp4", "https://10.0.0.7/a.mp4"]) {
      const fetched: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        fetched.push(url);
        if (url === start)
          return new Response(null, { status: 302, headers: { location: target } });
        return new Response("LEAKED", { status: 200 });
      });
      await expect(runCompleted("redir01", { outputs: [start] })).rejects.toThrow(ProviderError);
      expect(fetched).toEqual([start]);
    }
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("stops at MULTIX_MAX_DOWNLOAD_MB (declared and streamed sizes)", async () => {
    process.env.MULTIX_MAX_DOWNLOAD_MB = String(4 / (1024 * 1024)); // 4 bytes
    _resetEnvLoader();
    const declared = "https://m.test/declared.mp4";
    const streamed = "https://m.test/streamed.mp4";
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === declared) {
        return new Response("12345678", { headers: { "content-length": "8" } });
      }
      // No Content-Length: the cap must apply to the bytes actually received.
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("12345678"));
          c.close();
        },
      });
      return new Response(body);
    });
    for (const url of [declared, streamed]) {
      await expect(runCompleted("big01", { outputs: [url] })).rejects.toThrow(ProviderError);
    }
    const warned = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("MULTIX_MAX_DOWNLOAD_MB");
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("still saves inline data: outputs", async () => {
    const res = await runCompleted("data01", {
      outputs: [`data:audio/mpeg;base64,${Buffer.from("MP3DATA").toString("base64")}`],
    });
    expect(res.files).toEqual([path.join(tmp, "atlas-data01-01.mp3")]);
    expect(fs.readFileSync(res.files[0] as string, "utf8")).toBe("MP3DATA");
  });

  it("never overwrites an earlier output that shares the generated name, whatever its extension", async () => {
    // e.g. an earlier prediction with the same 8-character id prefix whose PNG became WebP.
    fs.writeFileSync(path.join(tmp, "atlas-same0001-01.webp"), "OLD");
    fs.writeFileSync(path.join(tmp, "atlas-same0001-01-1.mp4"), "OLDER");
    const url = "https://m.test/v.mp4";
    stubDownloads({ [url]: "NEW" });
    const res = await runCompleted("same0001-bbbb", { outputs: [url] }, { thumb: false });
    expect(res.files).toEqual([path.join(tmp, "atlas-same0001-01-2.mp4")]);
    expect(fs.readFileSync(path.join(tmp, "atlas-same0001-01.webp"), "utf8")).toBe("OLD");
    expect(fs.readFileSync(path.join(tmp, "atlas-same0001-01-1.mp4"), "utf8")).toBe("OLDER");
  });

  it("availableOutputPath returns the path itself when the stem is free", () => {
    expect(availableOutputPath(path.join(tmp, "a.png"))).toBe(path.join(tmp, "a.png"));
    expect(availableOutputPath(path.join(tmp, "missing-dir", "a.png"))).toBe(
      path.join(tmp, "missing-dir", "a.png"),
    );
    fs.writeFileSync(path.join(tmp, "a.txt"), "x");
    expect(availableOutputPath(path.join(tmp, "a.png"))).toBe(path.join(tmp, "a-1.png"));
  });

  it("ignores image URLs echoed from the request input when looking for a thumbnail", async () => {
    const video = "https://m.test/v.mp4";
    const fetched = stubDownloads({ [video]: "MP4" });
    const res = await runCompleted("thumb01", {
      outputs: [video],
      input: { image_url: "https://cdn.test/u/my-reference.png" },
      urls: { thumbnail_url: "https://cdn.test/u/other.jpg" },
    });
    expect(fetched).toEqual([video]);
    expect(res.files).toEqual([path.join(tmp, "atlas-thumb01-01.mp4")]);
    expect(fs.readdirSync(tmp)).toEqual(["atlas-thumb01-01.mp4"]);
  });

  it("downloads a thumbnail named in the outputs, under the same URL policy", async () => {
    const video = "https://m.test/v.mp4";
    const thumb = "https://m.test/t.jpg";
    const fetched = stubDownloads({ [video]: "MP4", [thumb]: "JPG" });
    await runCompleted("thumb02", { outputs: [{ url: video, thumbnail_url: thumb }] });
    expect(fetched).toEqual([video, thumb]);
    expect(fs.readFileSync(path.join(tmp, "atlas-thumb02-01_thumb.jpg"), "utf8")).toBe("JPG");

    const unsafe = "http://169.254.169.254/t.jpg";
    const fetched2 = stubDownloads({ [video]: "MP4" });
    const res = await runCompleted("thumb03", { outputs: [{ url: video, thumbnail_url: unsafe }] });
    expect(fetched2).toEqual([video]);
    expect(res.files).toEqual([path.join(tmp, "atlas-thumb03-01.mp4")]);
    expect(fs.existsSync(path.join(tmp, "atlas-thumb03-01_thumb.jpg"))).toBe(false);
  });
});
