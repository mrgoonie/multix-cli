import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, ValidationError } from "../../../../src/core/errors.js";
import { createLogger } from "../../../../src/core/logger.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import {
  ReplicateClient,
  ReplicatePredictionError,
} from "../../../../src/providers/replicate/client.js";
import {
  completePrediction,
  executePrediction,
} from "../../../../src/providers/replicate/commands/prediction-flow.js";
import { parseModelRef } from "../../../../src/providers/replicate/models.js";
import {
  createReplicateClient,
  replicateImageModel,
  replicateVideoModel,
  resolveReplicateToken,
} from "../../../../src/providers/replicate/node-client.js";
import {
  DATA_URI_MAX_BYTES,
  UPLOAD_MAX_BYTES,
  parseFileAssignments,
  resolveFileInput,
} from "../../../../src/providers/replicate/node-input-files.js";
import {
  resolveDestination,
  saveMediaOutputs,
} from "../../../../src/providers/replicate/node-outputs.js";
import { BASE, TOKEN, createFakeReplicate, noSleep, prediction } from "./fake-replicate.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const ID = "pred0001xyz";

let tmp: string;
let output: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-replicate-"));
  vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(tmp, "out"));
  _resetOutputDir();
  output = [];
  const capture = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function setup(routes: Parameters<typeof createFakeReplicate>[0]) {
  const fake = createFakeReplicate(routes);
  vi.stubGlobal("fetch", fake.fetch);
  const client = new ReplicateClient({
    apiKey: TOKEN,
    baseUrl: BASE,
    fetch: fake.fetch,
    sleep: noSleep,
  });
  return { fake, client };
}

const flowOpts = { waitTimeout: "60000" };

describe("executePrediction", () => {
  it("submits, polls to succeeded, and downloads every media output", async () => {
    const { fake, client } = setup({
      "POST /models/black-forest-labs/flux-schnell/predictions": [
        { status: 201, json: prediction(ID, "starting") },
      ],
      [`GET /predictions/${ID}`]: [
        { json: prediction(ID, "processing") },
        {
          json: prediction(ID, "succeeded", {
            output: [
              "https://replicate.delivery/a/out-0.png",
              "https://replicate.delivery/a/out-1",
            ],
          }),
        },
      ],
      "GET https://replicate.delivery/a/out-0.png": [{ bytes: PNG }],
      "GET https://replicate.delivery/a/out-1": [
        { bytes: PNG, headers: { "content-type": "image/webp" } },
      ],
    });
    await executePrediction({
      client,
      model: parseModelRef("black-forest-labs/flux-schnell"),
      input: { prompt: "cube" },
      opts: flowOpts,
      logger: createLogger({ verbose: false }),
    });
    const outDir = path.join(tmp, "out");
    expect(fs.readdirSync(outDir).sort()).toEqual([
      "replicate-pred0001-01.png",
      "replicate-pred0001-02.webp",
    ]);
    expect(new Uint8Array(fs.readFileSync(path.join(outDir, "replicate-pred0001-01.png")))).toEqual(
      PNG,
    );
    expect(output.join("\n")).toContain("Saved 2 file(s)");
    expect(fake.calls.filter((c) => c.url.includes(`/predictions/${ID}`))).toHaveLength(2);
  });

  it("fails loudly on a failed prediction and saves nothing", async () => {
    const { client } = setup({
      "POST /models/o/m/predictions": [{ status: 201, json: prediction(ID, "starting") }],
      [`GET /predictions/${ID}`]: [
        { json: prediction(ID, "failed", { error: "NSFW content detected" }) },
      ],
    });
    await expect(
      executePrediction({
        client,
        model: parseModelRef("o/m"),
        input: {},
        opts: flowOpts,
        logger: createLogger({ verbose: false }),
      }),
    ).rejects.toThrow(ReplicatePredictionError);
    expect(fs.existsSync(path.join(tmp, "out"))).toBe(false);
  });

  it("--async prints the id with resume/cancel commands and does not poll", async () => {
    const { fake, client } = setup({
      "POST /models/o/m/predictions": [{ status: 201, json: prediction(ID, "starting") }],
    });
    await executePrediction({
      client,
      model: parseModelRef("o/m"),
      input: {},
      opts: { ...flowOpts, async: true },
      logger: createLogger({ verbose: false }),
    });
    const text = output.join("\n");
    expect(text).toContain(`Prediction submitted: ${ID}`);
    expect(text).toContain(`multix replicate status ${ID} --wait --download`);
    expect(text).toContain(`multix replicate cancel ${ID}`);
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects contradictory flags before any request", async () => {
    const { fake, client } = setup({});
    const run = (opts: Record<string, unknown>) =>
      executePrediction({
        client,
        model: parseModelRef("o/m"),
        input: {},
        opts: { ...flowOpts, ...opts },
        logger: createLogger({ verbose: false }),
      });
    await expect(run({ async: true, wait: true })).rejects.toThrow(ValidationError);
    await expect(run({ async: true, preferWait: 30 })).rejects.toThrow(ValidationError);
    await expect(run({ waitTimeout: "soon" })).rejects.toThrow(/--wait-timeout/);
    expect(fake.calls).toHaveLength(0);
  });

  it("--prefer-wait sends the header and still polls a nonterminal response", async () => {
    const { fake, client } = setup({
      "POST /models/o/m/predictions": [{ status: 201, json: prediction(ID, "processing") }],
      [`GET /predictions/${ID}`]: [{ json: prediction(ID, "succeeded", { output: "done" }) }],
    });
    await executePrediction({
      client,
      model: parseModelRef("o/m"),
      input: {},
      opts: { ...flowOpts, preferWait: 5 },
      logger: createLogger({ verbose: false }),
    });
    expect(fake.calls[0]?.headers.prefer).toBe("wait=5");
    expect(output).toContain("done");
  });

  it("--no-download prints the output URLs", async () => {
    const { client } = setup({
      "POST /models/o/m/predictions": [
        { status: 201, json: prediction(ID, "succeeded", { output: "https://r.test/v.mp4" }) },
      ],
    });
    await executePrediction({
      client,
      model: parseModelRef("o/m"),
      input: {},
      opts: { ...flowOpts, download: false },
      logger: createLogger({ verbose: false }),
    });
    expect(output).toContain("https://r.test/v.mp4");
  });

  it("never logs the token or signed URL query strings, even verbose", async () => {
    const signed = "https://cdn.test/o.mp4?X-Amz-Signature=SIGSECRET";
    const { client } = setup({
      "POST /models/o/m/predictions": [{ status: 201, json: prediction(ID, "starting") }],
      [`GET /predictions/${ID}`]: [{ json: prediction(ID, "succeeded", { output: signed }) }],
      [`GET ${signed}`]: [{ status: 403, text: "expired" }],
    });
    await expect(
      executePrediction({
        client,
        model: parseModelRef("o/m"),
        input: {},
        opts: flowOpts,
        logger: createLogger({ verbose: true }),
      }),
    ).rejects.toThrow(/none of 1 output file\(s\) could be downloaded/);
    const text = output.join("\n");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("SIGSECRET");
    expect(text).toContain("?[redacted]");
  });
});

describe("partial download failure", () => {
  it("keeps the saved files but exits non-zero with a retry command", async () => {
    const { client } = setup({
      "POST /models/o/m/predictions": [{ status: 201, json: prediction(ID, "starting") }],
      [`GET /predictions/${ID}`]: [
        {
          json: prediction(ID, "succeeded", {
            output: ["https://r.test/ok.png", "https://r.test/gone.png"],
          }),
        },
      ],
      "GET https://r.test/ok.png": [{ bytes: PNG }],
      "GET https://r.test/gone.png": [{ status: 404, text: "expired" }],
    });
    const err = await executePrediction({
      client,
      model: parseModelRef("o/m"),
      input: {},
      opts: flowOpts,
      logger: createLogger({ verbose: false }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("1 of 2 output file(s) failed to download ([1])");
    expect((err as Error).message).toContain(`multix replicate status ${ID} --download`);
    expect((err as Error).message).toContain(
      `print the URLs to fetch elsewhere: multix replicate status ${ID})`,
    );
    expect(fs.readdirSync(path.join(tmp, "out"))).toEqual(["replicate-pred0001-01.png"]);
  });
});

describe("output download policy", () => {
  function succeededWith(output: unknown, extra: Parameters<typeof setup>[0] = {}) {
    return setup({
      [`GET /predictions/${ID}`]: [{ json: prediction(ID, "succeeded", { output }) }],
      ...extra,
    });
  }
  const resume = (client: ReplicateClient) =>
    completePrediction(client, ID, {
      waitTimeoutMs: 60_000,
      logger: createLogger({ verbose: false }),
      download: true,
    });

  it("refuses http:// and private-address outputs without fetching them", async () => {
    const { client, fake } = succeededWith([
      "http://replicate.delivery/a/out.png",
      "https://169.254.169.254/latest/meta-data",
    ]);
    await expect(resume(client)).rejects.toThrow(/none of 2 output file\(s\)/);
    const text = output.join("\n");
    expect(text).toContain("only https:// URLs are allowed");
    expect(text).toContain("local or private address");
    expect(fake.calls.map((c) => c.url)).toEqual([`${BASE}/predictions/${ID}`]);
  });

  it("warns with the hostname only for hosts other than replicate.delivery", async () => {
    const signed = "https://cdn.example.com/o.png?X-Amz-Signature=SIGSECRET";
    const { client } = succeededWith(signed, { [`GET ${signed}`]: [{ bytes: PNG }] });
    await resume(client);
    const text = output.join("\n");
    expect(text).toContain("served from cdn.example.com, not one of Replicate's output hosts");
    expect(text).not.toContain("SIGSECRET");
    expect(fs.readdirSync(path.join(tmp, "out"))).toEqual(["replicate-pred0001-01.png"]);
  });

  it("warns once per untrusted host, not once per output", async () => {
    const urls = ["https://cdn.example.com/a.png", "https://cdn.example.com/b.png"];
    const { client } = succeededWith(urls, {
      [`GET ${urls[0]}`]: [{ bytes: PNG }],
      [`GET ${urls[1]}`]: [{ bytes: PNG }],
    });
    expect(await resume(client)).toHaveLength(2);
    const warnings = output.filter((line) => line.includes("served from cdn.example.com"));
    expect(warnings).toHaveLength(1);
  });

  it("keeps an existing --output file when the download fails", async () => {
    const url = "https://replicate.delivery/a/out.png";
    const { client } = succeededWith(url, { [`GET ${url}`]: [{ status: 404, text: "gone" }] });
    const dest = path.join(tmp, "hero.png");
    fs.writeFileSync(dest, "precious");
    await expect(
      completePrediction(client, ID, {
        waitTimeoutMs: 60_000,
        logger: createLogger({ verbose: false }),
        download: true,
        output: dest,
      }),
    ).rejects.toThrow(/none of 1/);
    expect(fs.readFileSync(dest, "utf8")).toBe("precious");
    expect(fs.readdirSync(tmp).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("validates every redirect hop and refuses a redirect to a private address", async () => {
    const start = "https://replicate.delivery/a/out.png";
    const { client, fake } = succeededWith(start, {
      [`GET ${start}`]: [
        { status: 302, text: "", headers: { location: "http://127.0.0.1:8080/secret" } },
      ],
    });
    await expect(resume(client)).rejects.toThrow(/none of 1/);
    expect(output.join("\n")).toContain("only https://");
    expect(fake.calls.filter((c) => c.url.includes("127.0.0.1"))).toHaveLength(0);
  });

  it("follows a safe redirect", async () => {
    const start = "https://replicate.delivery/a/out.png";
    const next = "https://pbxt.replicate.delivery/b/out.png";
    const { client } = succeededWith(start, {
      [`GET ${start}`]: [{ status: 307, text: "", headers: { location: next } }],
      [`GET ${next}`]: [{ bytes: PNG }],
    });
    expect(await resume(client)).toHaveLength(1);
  });

  it("stops at MULTIX_MAX_DOWNLOAD_MB and removes the partial file", async () => {
    vi.stubEnv("MULTIX_MAX_DOWNLOAD_MB", "0.000001"); // 1 byte
    const url = "https://replicate.delivery/a/out.png";
    const { client } = succeededWith(url, { [`GET ${url}`]: [{ bytes: PNG }] });
    await expect(resume(client)).rejects.toThrow(/none of 1/);
    expect(output.join("\n")).toContain("MULTIX_MAX_DOWNLOAD_MB");
    const outDir = path.join(tmp, "out");
    expect(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []).toEqual([]);
  });

  it("rejects an invalid MULTIX_MAX_DOWNLOAD_MB before downloading", async () => {
    vi.stubEnv("MULTIX_MAX_DOWNLOAD_MB", "lots");
    const url = "https://replicate.delivery/a/out.png";
    const { client, fake } = succeededWith(url, { [`GET ${url}`]: [{ bytes: PNG }] });
    await expect(resume(client)).rejects.toThrow(ConfigError);
    expect(fake.calls.filter((c) => c.url === url)).toHaveLength(0);
  });
});

describe("download retries", () => {
  const url = "https://replicate.delivery/a/out.png";
  const networkError = () =>
    new TypeError("fetch failed", { cause: new Error("Connect Timeout Error") });

  function save(responses: Parameters<typeof createFakeReplicate>[0][string]) {
    const fake = createFakeReplicate({ [`GET ${url}`]: responses });
    const waits: number[] = [];
    const run = saveMediaOutputs(ID, [{ url, path: "output" }], {
      outDir: path.join(tmp, "out"),
      logger: createLogger({ verbose: false }),
      fetch: fake.fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    return { fake, waits, run };
  }

  it("retries a network error and a 5xx, then saves the file", async () => {
    const { fake, waits, run } = save([
      { throws: networkError() },
      { status: 503, text: "busy" },
      { bytes: PNG },
    ]);
    expect(await run).toEqual([path.join(tmp, "out", "replicate-pred0001-01.png")]);
    expect(fake.calls).toHaveLength(3);
    expect(waits).toEqual([1_000, 3_000]);
    expect(output.join("\n")).toContain(
      "Retrying output in 1s (network error reaching replicate.delivery",
    );
  });

  it("gives up after three attempts and names the network error, not HTTP 0", async () => {
    const { fake, run } = save([{ throws: networkError() }]);
    await expect(run).rejects.toThrow(/none of 1 output file\(s\) could be downloaded/);
    expect(fake.calls).toHaveLength(3);
    const failure = output.find((line) => line.includes("Download failed for output"));
    expect(failure).toContain("network error reaching replicate.delivery: ");
    expect(failure).not.toContain("HTTP 0");
  });

  it("honours Retry-After on 429, capped at 30s", async () => {
    const { waits, run } = save([
      { status: 429, text: "slow down", headers: { "retry-after": "5" } },
      { status: 429, text: "slow down", headers: { "retry-after": "600" } },
      { bytes: PNG },
    ]);
    await run;
    expect(waits).toEqual([5_000, 30_000]);
  });

  it("retries a connection dropped mid-body without leaving a partial file", async () => {
    const dropped = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PNG);
        controller.error(new TypeError("terminated"));
      },
    });
    const responses = [new Response(dropped), new Response(PNG)];
    const waits: number[] = [];
    const saved = await saveMediaOutputs(ID, [{ url, path: "output" }], {
      outDir: path.join(tmp, "out"),
      logger: createLogger({ verbose: false }),
      fetch: async () => responses.shift() as Response,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(saved).toHaveLength(1);
    expect(fs.readdirSync(path.join(tmp, "out"))).toEqual(["replicate-pred0001-01.png"]);
    expect(waits).toEqual([1_000]);
    expect(output.join("\n")).toContain(
      "connection to replicate.delivery dropped mid-download: terminated",
    );
  });

  it("names only the host in retry lines, never the path or signed query", async () => {
    const signed = "https://replicate.delivery/secretpath/o.png?X-Amz-Signature=SIGSECRET";
    const fake = createFakeReplicate({
      [`GET ${signed}`]: [{ status: 502, text: "bad gateway" }, { bytes: PNG }],
    });
    await saveMediaOutputs(ID, [{ url: signed, path: "output" }], {
      outDir: path.join(tmp, "out"),
      logger: createLogger({ verbose: false }),
      fetch: fake.fetch,
      sleep: async () => {},
    });
    const text = output.join("\n");
    expect(text).toContain("Retrying output in 1s (HTTP 502 from replicate.delivery)");
    expect(text).not.toContain("SIGSECRET");
    expect(text).not.toContain("secretpath");
  });

  it("does not retry a file-system error", async () => {
    const blocker = path.join(tmp, "blocker");
    fs.writeFileSync(blocker, "");
    const fake = createFakeReplicate({ [`GET ${url}`]: [{ bytes: PNG }] });
    await expect(
      saveMediaOutputs(ID, [{ url, path: "output" }], {
        outDir: "",
        output: path.join(blocker, "sub", "o.png"),
        logger: createLogger({ verbose: false }),
        fetch: fake.fetch,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/none of 1/);
    expect(fake.calls).toHaveLength(1);
  });

  it("does not retry an expired (404) output", async () => {
    const { fake, waits, run } = save([{ status: 404, text: "gone" }]);
    await expect(run).rejects.toThrow(/none of 1/);
    expect(fake.calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });
});

describe("completePrediction (resume by id)", () => {
  it("waits on an existing id and saves to an explicit --output path", async () => {
    const { client } = setup({
      [`GET /predictions/${ID}`]: [
        { json: prediction(ID, "succeeded", { output: "https://r.test/clip" }) },
      ],
      "GET https://r.test/clip": [{ bytes: PNG, headers: { "content-type": "video/mp4" } }],
    });
    const dest = path.join(tmp, "custom", "clip");
    const saved = await completePrediction(client, ID, {
      waitTimeoutMs: 60_000,
      logger: createLogger({ verbose: false }),
      download: true,
      output: dest,
    });
    expect(saved).toEqual([`${dest}.mp4`]);
    expect(fs.existsSync(`${dest}.mp4`)).toBe(true);
  });

  it("rejects a canceled prediction", async () => {
    const { client } = setup({
      [`GET /predictions/${ID}`]: [{ json: prediction(ID, "canceled") }],
    });
    await expect(
      completePrediction(client, ID, {
        waitTimeoutMs: 60_000,
        logger: createLogger({ verbose: false }),
        download: true,
      }),
    ).rejects.toThrow(/canceled/);
  });
});

describe("resolveDestination", () => {
  it("names files in the output dir, an explicit file, or numbered beside it", () => {
    const opts = { outDir: tmp };
    expect(resolveDestination(ID, 0, 1, ".png", opts)).toBe(
      path.join(tmp, "replicate-pred0001-01.png"),
    );
    const file = path.join(tmp, "img.png");
    expect(resolveDestination(ID, 0, 1, ".webp", { outDir: tmp, output: file })).toBe(file);
    expect(resolveDestination(ID, 1, 2, ".webp", { outDir: tmp, output: file })).toBe(
      path.join(tmp, "img-02.webp"),
    );
    expect(resolveDestination(ID, 0, 2, ".png", { outDir: "", output: tmp })).toBe(
      path.join(tmp, "replicate-pred0001-01.png"),
    );
  });
});

describe("resolveFileInput", () => {
  const logger = createLogger({ verbose: false });

  it("passes URLs and data URIs through unchanged", async () => {
    const { client, fake } = setup({});
    expect(await resolveFileInput("https://x.test/a.png", client, logger)).toBe(
      "https://x.test/a.png",
    );
    expect(await resolveFileInput("data:image/png;base64,AA", client, logger)).toBe(
      "data:image/png;base64,AA",
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("inlines small files as data URIs", async () => {
    const { client, fake } = setup({});
    const file = path.join(tmp, "small.png");
    fs.writeFileSync(file, PNG);
    const value = await resolveFileInput(file, client, logger);
    expect(value).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
    expect(fake.calls).toHaveLength(0);
  });

  it("uploads larger files via the Files API", async () => {
    const { client, fake } = setup({
      "POST /files": [
        {
          status: 201,
          json: {
            id: "f9",
            content_type: "image/jpeg",
            size: 1,
            urls: { get: `${BASE}/files/f9` },
          },
        },
      ],
    });
    const file = path.join(tmp, "big.jpg");
    fs.writeFileSync(file, Buffer.alloc(DATA_URI_MAX_BYTES + 1, 1));
    expect(await resolveFileInput(file, client, logger)).toBe(`${BASE}/files/f9`);
    expect(fake.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("rejects missing files and files over the 100MB limit", async () => {
    const { client } = setup({});
    await expect(resolveFileInput(path.join(tmp, "nope.png"), client, logger)).rejects.toThrow(
      /not found/,
    );
    const huge = path.join(tmp, "huge.mp4");
    fs.closeSync(fs.openSync(huge, "w"));
    fs.truncateSync(huge, UPLOAD_MAX_BYTES);
    await expect(resolveFileInput(huge, client, logger)).rejects.toThrow(/under 100MB/);
  });

  it("parses --file key=path assignments", () => {
    expect(parseFileAssignments(["image=./a.png", "mask = b.png"])).toEqual([
      ["image", "./a.png"],
      ["mask", "b.png"],
    ]);
    expect(() => parseFileAssignments(["./a.png"])).toThrow(ValidationError);
    expect(() => parseFileAssignments(["bad-key=a"])).toThrow(ValidationError);
  });
});

describe("node-client env resolution", () => {
  it("prefers REPLICATE_API_TOKEN and falls back to REPLICATE_API_KEY", () => {
    vi.stubEnv("REPLICATE_API_TOKEN", "");
    vi.stubEnv("REPLICATE_API_KEY", "fallback-token");
    expect(resolveReplicateToken()).toEqual({
      token: "fallback-token",
      envUsed: "REPLICATE_API_KEY",
    });
    vi.stubEnv("REPLICATE_API_TOKEN", "primary-token");
    expect(resolveReplicateToken()?.envUsed).toBe("REPLICATE_API_TOKEN");
  });

  it("throws ConfigError without a token", () => {
    vi.stubEnv("REPLICATE_API_TOKEN", "");
    vi.stubEnv("REPLICATE_API_KEY", "");
    expect(() => createReplicateClient()).toThrow(ConfigError);
  });

  it("honours REPLICATE_BASE_URL and model overrides", async () => {
    vi.stubEnv("REPLICATE_API_TOKEN", TOKEN);
    vi.stubEnv("REPLICATE_BASE_URL", BASE);
    vi.stubEnv("REPLICATE_IMAGE_MODEL", "a/img");
    vi.stubEnv("REPLICATE_VIDEO_MODEL", "");
    expect(replicateImageModel()).toBe("a/img");
    expect(replicateVideoModel()).toBe("prunaai/p-video");
    const fake = createFakeReplicate({
      [`GET /predictions/${ID}`]: [{ json: prediction(ID, "starting") }],
    });
    vi.stubGlobal("fetch", fake.fetch);
    await createReplicateClient().getPrediction(ID);
    expect(fake.calls[0]?.url).toBe(`${BASE}/predictions/${ID}`);
  });
});
