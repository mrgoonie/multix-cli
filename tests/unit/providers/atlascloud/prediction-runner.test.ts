import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../../../src/agent/run-state.js";
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
  availableOutputPath,
  claimOutputPath,
  handleInterrupt,
  releaseClaim,
  savedOutput,
} from "../../../../src/providers/atlascloud/commands/output-claims.js";
import {
  assertEndpoint,
  executePrediction,
  loadModelSpec,
  planOutputPaths,
  resumeCommand,
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
  it("image: black-forest-labs/flux-schnell saves atlas-<prediction id>-01.jpg", async () => {
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
    const expected = path.join(tmp, "atlas-47e7acf05d7449c1-01.jpg");
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
      "atlas-song1234xyz-01.mp3",
      "atlas-song1234xyz-02.mp3",
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
      opts: { async: true, output: "my clips" },
      defaultWaitTimeoutMs: 60_000,
    });
    expect(res.files).toEqual([]);
    expect(stdout).toEqual(["async01"]);
    expect(calls).toHaveLength(1);
    // The resume command keeps --output, so the files land where the user asked.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('multix atlas status async01 --wait --download --output "my clips"'),
    );
  });

  it("Ctrl-C while polling exits 130 with the id and resume command, without resubmitting", async () => {
    const { client, calls } = createFakeAtlas({
      "POST /model/generateImage": { body: prediction("wait01", "processing") },
      "GET /model/prediction/wait01": { body: prediction("wait01", "processing") },
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exits: number[] = [];
    const before = process.listenerCount("SIGINT");
    let polls = 0;
    const res = executePrediction({
      client,
      logger,
      kind: "image",
      model: "m/x",
      body: { prompt: "x" },
      opts: { output: "my clips" },
      defaultWaitTimeoutMs: 60_000,
      pollIntervalMs: 1,
      exit: (code) => {
        exits.push(code);
        throw new Error("exited");
      },
    });
    // Signal from inside the first poll, as a real Ctrl-C would arrive mid-wait. Only the
    // newest listener is called: earlier download tests leave output-claims' own handler.
    const origGet = client.getPrediction.bind(client);
    vi.spyOn(client, "getPrediction").mockImplementation(async (...a) => {
      if (++polls === 1) (process.listeners("SIGINT").at(-1) as (s: string) => void)("SIGINT");
      return origGet(...a);
    });
    await expect(res).rejects.toThrow("exited");
    expect(exits).toEqual([130]);
    const resume = 'multix atlas status wait01 --wait --download --output "my clips"';
    expect(run.inFlight).toEqual({ id: "wait01", resume });
    expect(run.ids).toContain("wait01");
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`Resume with: ${resume}`));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    // The handler is removed once the wait ends, so a later Ctrl-C is not swallowed.
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("resumeCommand adds --output only when given, quoting it when needed", () => {
    expect(resumeCommand("p1")).toBe("multix atlas status p1 --wait --download");
    expect(resumeCommand("p1", "out/clip.mp4")).toBe(
      "multix atlas status p1 --wait --download --output out/clip.mp4",
    );
    expect(resumeCommand("p1", 'a "b" $c')).toBe(
      'multix atlas status p1 --wait --download --output "a \\"b\\" \\$c"',
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
      path.join(tmp, "atlas-abcdef123-01.png"),
      path.join(tmp, "atlas-abcdef123-02.png"),
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

  it("a retry keeps the outputs an earlier run saved and downloads only the missing ones", async () => {
    const urls = ["https://m.test/a.mp4", "https://m.test/b.mp4"];
    const first = stubDownloads({ [urls[0] as string]: "A", [urls[1] as string]: 500 });
    await expect(runCompleted("retry0001-full-id", { outputs: urls })).rejects.toThrow(
      /1 failed.*multix atlas status retry0001-full-id --wait --download/,
    );
    expect(first).toEqual(urls);

    const second = stubDownloads({ [urls[1] as string]: "B" });
    const res = await runCompleted("retry0001-full-id", { outputs: urls });
    expect(second).toEqual([urls[1]]);
    const names = ["atlas-retry0001-full-id-01.mp4", "atlas-retry0001-full-id-02.mp4"];
    expect(res.files).toEqual(names.map((n) => path.join(tmp, n)));
    expect(fs.readdirSync(tmp).sort()).toEqual(names);
    expect(stdout).toContain(`  ${path.join(tmp, names[0] as string)} (already saved)`);

    // A third run downloads nothing at all.
    const third = stubDownloads({});
    await runCompleted("retry0001-full-id", { outputs: urls });
    expect(third).toEqual([]);
    expect(fs.readdirSync(tmp).sort()).toEqual(names);
  });

  it("reuses an output saved under another extension (e.g. PNG -> WebP), even for an extensionless URL", async () => {
    fs.writeFileSync(path.join(tmp, "atlas-reuse01-01.webp"), "OLD");
    const fetched = stubDownloads({});
    const res = await runCompleted("reuse01", { outputs: ["https://m.test/out/noext"] });
    expect(fetched).toEqual([]);
    expect(res.files).toEqual([path.join(tmp, "atlas-reuse01-01.webp")]);
    expect(fs.readFileSync(path.join(tmp, "atlas-reuse01-01.webp"), "utf8")).toBe("OLD");
  });

  it("refuses a name a running process holds (.part lock with a live pid)", async () => {
    const part = path.join(tmp, "atlas-busy01-01.mp4.part");
    // The parent process (the test runner) is alive and is not this process.
    const lock = JSON.stringify({ pid: process.ppid, host: os.hostname(), startedAt: "x" });
    fs.writeFileSync(part, lock);
    stubDownloads({ "https://m.test/v.mp4": "NEW" });
    await expect(runCompleted("busy01", { outputs: ["https://m.test/v.mp4"] })).rejects.toThrow(
      ProviderError,
    );
    const warned = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain(`held by another multix run (pid ${process.ppid}`);
    expect(fs.readFileSync(part, "utf8")).toBe(lock);
    expect(fs.readdirSync(tmp)).toEqual(["atlas-busy01-01.mp4.part"]);
  });

  it("takes over a lock and removes temp files left by a process that is gone (Ctrl+C, kill)", async () => {
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid as number;
    const dest = path.join(tmp, "atlas-stale01-01.mp4");
    fs.writeFileSync(
      `${dest}.part`,
      JSON.stringify({ pid: deadPid, host: os.hostname(), startedAt: "x" }),
    );
    fs.writeFileSync(`${dest}.${deadPid}-1700000000000-k3x9qa.part`, "PARTIAL");
    // An unrelated file that merely starts with the same name is never touched.
    fs.writeFileSync(`${dest}.${deadPid}-notes.part`, "MINE");
    stubDownloads({ "https://m.test/v.mp4": "NEW" });
    const res = await runCompleted("stale01", { outputs: ["https://m.test/v.mp4"] });
    expect(res.files).toEqual([dest]);
    expect(fs.readFileSync(dest, "utf8")).toBe("NEW");
    expect(fs.readdirSync(tmp).sort()).toEqual(
      ["atlas-stale01-01.mp4", `atlas-stale01-01.mp4.${deadPid}-notes.part`].sort(),
    );
  });

  it("does not count an empty file as an output already saved", async () => {
    const dest = path.join(tmp, "atlas-empty01-01.mp4");
    fs.writeFileSync(dest, "");
    const fetched = stubDownloads({ "https://m.test/v.mp4": "NEW" });
    const res = await runCompleted("empty01", { outputs: ["https://m.test/v.mp4"] });
    expect(fetched).toEqual(["https://m.test/v.mp4"]);
    expect(res.files).toEqual([dest]);
    expect(fs.readFileSync(dest, "utf8")).toBe("NEW");
    expect(savedOutput(path.join(tmp, "missing.mp4"))).toBeUndefined();
  });

  it("the interrupt handler removes this run's locks and temp files, then exits 130/143", () => {
    const file = path.join(tmp, "atlas-int01-01.mp4");
    expect(claimOutputPath(file, "reuse")).toBe(file);
    const temp = `${file}.${process.pid}-1700000000000-k3x9qa.part`;
    fs.writeFileSync(temp, "PARTIAL");
    fs.writeFileSync(path.join(tmp, "keep.mp4"), "MINE");
    const exit = vi.fn();
    handleInterrupt("SIGINT", exit);
    expect(exit).toHaveBeenCalledWith(130);
    expect(fs.readdirSync(tmp)).toEqual(["keep.mp4"]);

    claimOutputPath(file, "reuse");
    handleInterrupt("SIGTERM", exit);
    expect(exit).toHaveBeenLastCalledWith(143);
    expect(fs.readdirSync(tmp)).toEqual(["keep.mp4"]);
  });

  it("overwrites an explicit single-file --output as asked", async () => {
    const dest = path.join(tmp, "clip.mp4");
    fs.writeFileSync(dest, "OLD");
    stubDownloads({ "https://m.test/v.mp4": "NEW" });
    const res = await runCompleted(
      "explicit01",
      { outputs: ["https://m.test/v.mp4"] },
      { output: dest },
    );
    expect(res.files).toEqual([dest]);
    expect(fs.readFileSync(dest, "utf8")).toBe("NEW");
    expect(fs.readdirSync(tmp)).toEqual(["clip.mp4"]);
  });

  it("a multi-output --output stem never overwrites unrelated files, also for Content-Type names", async () => {
    // Extensionless URLs: the extension comes from the response Content-Type.
    const urls = ["https://m.test/out/first", "https://m.test/out/second"];
    vi.stubGlobal(
      "fetch",
      async () => new Response("NEW", { headers: { "content-type": "video/mp4" } }),
    );
    fs.writeFileSync(path.join(tmp, "shot-01.txt"), "MINE");
    fs.writeFileSync(path.join(tmp, "shot-02.mp4.part"), "SOMEONE ELSE");
    const res = await runCompleted(
      "tmpl01",
      { outputs: urls },
      { output: path.join(tmp, "shot.mp4") },
    );
    expect(res.files).toEqual([path.join(tmp, "shot-01-1.mp4"), path.join(tmp, "shot-02-1.mp4")]);
    expect(fs.readFileSync(path.join(tmp, "shot-01.txt"), "utf8")).toBe("MINE");
    expect(fs.readFileSync(path.join(tmp, "shot-02.mp4.part"), "utf8")).toBe("SOMEONE ELSE");
  });

  it("availableOutputPath returns the path itself when the stem is free", () => {
    expect(availableOutputPath(path.join(tmp, "a.png"))).toBe(path.join(tmp, "a.png"));
    expect(availableOutputPath(path.join(tmp, "missing-dir", "a.png"))).toBe(
      path.join(tmp, "missing-dir", "a.png"),
    );
    fs.writeFileSync(path.join(tmp, "a.txt"), "x");
    expect(availableOutputPath(path.join(tmp, "a.png"))).toBe(path.join(tmp, "a-1.png"));
    fs.writeFileSync(path.join(tmp, "a-1.png.part"), "x");
    expect(availableOutputPath(path.join(tmp, "a.png"))).toBe(path.join(tmp, "a-2.png"));
    // downloadToFile's own in-flight file: taken for new names, never a saved output.
    fs.writeFileSync(path.join(tmp, "a-2.png.4242-1700000000000-k3x9qa.part"), "x");
    expect(availableOutputPath(path.join(tmp, "a.png"))).toBe(path.join(tmp, "a-3.png"));
    expect(savedOutput(path.join(tmp, "a-2.png"))).toBeUndefined();
  });

  it("leaves no .part file behind after a successful or a failed download", async () => {
    stubDownloads({ "https://m.test/ok.mp4": "OK" });
    await runCompleted("clean01", { outputs: ["https://m.test/ok.mp4"] });
    expect(fs.readdirSync(tmp)).toEqual(["atlas-clean01-01.mp4"]);

    // Fails mid-stream, after the name was claimed.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("partial"));
              c.error(new Error("connection reset"));
            },
          }),
        ),
    );
    await expect(runCompleted("clean02", { outputs: ["https://m.test/bad.mp4"] })).rejects.toThrow(
      ProviderError,
    );
    expect(fs.readdirSync(tmp)).toEqual(["atlas-clean01-01.mp4"]);
  });

  it.runIf(process.platform === "win32" || process.platform === "darwin")(
    "matches names case-insensitively where the file system does",
    () => {
      fs.writeFileSync(path.join(tmp, "Shot.PNG"), "x");
      expect(availableOutputPath(path.join(tmp, "shot.png"))).toBe(path.join(tmp, "shot-1.png"));
      expect(savedOutput(path.join(tmp, "SHOT.webp"))).toBe(path.join(tmp, "Shot.PNG"));
    },
  );

  it("claimOutputPath reserves the name so a second claim cannot take it", () => {
    const file = path.join(tmp, "sub", "atlas-x-01.mp4");
    expect(claimOutputPath(file, "reuse")).toBe(file);
    const lock = JSON.parse(fs.readFileSync(`${file}.part`, "utf8"));
    expect(lock).toMatchObject({ pid: process.pid, host: os.hostname() });
    expect(() => claimOutputPath(file, "reuse")).toThrow(/held by another multix run/);
    const second = path.join(tmp, "sub", "atlas-x-01-1.mp4");
    expect(claimOutputPath(file, "unique")).toBe(second);
    expect(claimOutputPath(file, "overwrite")).toBe(file);
    releaseClaim(file);
    releaseClaim(second);
    expect(fs.readdirSync(path.join(tmp, "sub"))).toEqual([]);
  });

  it("claimOutputPath treats an unreadable lock as held at first, then as stale", () => {
    const file = path.join(tmp, "atlas-y-01.mp4");
    fs.writeFileSync(`${file}.part`, "");
    expect(() => claimOutputPath(file, "reuse")).toThrow(/held by another multix run/);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${file}.part`, old, old);
    expect(claimOutputPath(file, "reuse")).toBe(file);
    releaseClaim(file);
  });

  // Creating 1000 files can take longer than the default 5 s on Windows runners.
  it("claimOutputPath gives up on a multi-output name after a bounded number of attempts", () => {
    const file = path.join(tmp, "z.mp4");
    fs.writeFileSync(file, "x");
    for (let n = 1; n < 1000; n++) fs.writeFileSync(path.join(tmp, `z-${n}.mp4`), "x");
    expect(() => claimOutputPath(file, "unique")).toThrow(/No free file name .* 1000 attempts/);
  }, 30_000);

  it("saves an svg output as .svg and never converts it", async () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`;
    const { client } = createFakeAtlas({
      "POST /model/generateImage": { body: prediction("svg01", "completed", { outputs: [svg] }) },
    });
    const res = await executePrediction({
      client,
      logger,
      kind: "image",
      model: "m/x",
      body: { prompt: "x" },
      opts: {},
      hint: "image",
      defaultWaitTimeoutMs: 60_000,
    });
    expect(res.files).toEqual([path.join(tmp, "atlas-svg01-01.svg")]);
    expect(fs.readFileSync(res.files[0] as string, "utf8")).toBe("<svg/>");
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

    // Rerun: the video and its thumbnail are both kept, nothing is fetched again.
    const refetched = stubDownloads({});
    await runCompleted("thumb02", { outputs: [{ url: video, thumbnail_url: thumb }] });
    expect(refetched).toEqual([]);
    expect(fs.readdirSync(tmp).sort()).toEqual([
      "atlas-thumb02-01.mp4",
      "atlas-thumb02-01_thumb.jpg",
    ]);

    // Refused by scheme, and over https by a private / link-local address.
    for (const [id, unsafe] of [
      ["thumb03", "http://169.254.169.254/t.jpg"],
      ["thumb04", "https://169.254.169.254/t.jpg"],
      ["thumb05", "https://10.0.0.8/t.jpg"],
    ] as const) {
      const fetched2 = stubDownloads({ [video]: "MP4" });
      const res = await runCompleted(id, { outputs: [{ url: video, thumbnail_url: unsafe }] });
      expect(fetched2).toEqual([video]);
      expect(res.files).toEqual([path.join(tmp, `atlas-${id}-01.mp4`)]);
      expect(fs.existsSync(path.join(tmp, `atlas-${id}-01_thumb.jpg`))).toBe(false);
    }
    const warned = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("local or private address");
  });

  it("a thumbnail from a multi-output --output stem never overwrites an orphan thumbnail", async () => {
    const urls = ["https://m.test/a.mp4", "https://m.test/b.mp4"];
    const thumb = "https://m.test/t.jpg";
    stubDownloads({ [urls[0] as string]: "A", [urls[1] as string]: "B", [thumb]: "NEWTHUMB" });
    fs.writeFileSync(path.join(tmp, "clip-01_thumb.jpg"), "ORPHAN");
    await runCompleted(
      "thumb06",
      { outputs: [{ url: urls[0], thumbnail_url: thumb }, urls[1]] },
      { output: path.join(tmp, "clip.mp4") },
    );
    expect(fs.readFileSync(path.join(tmp, "clip-01_thumb.jpg"), "utf8")).toBe("ORPHAN");
    expect(fs.readFileSync(path.join(tmp, "clip-01_thumb-1.jpg"), "utf8")).toBe("NEWTHUMB");
  });
});
