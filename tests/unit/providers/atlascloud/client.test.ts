import { describe, expect, it, vi } from "vitest";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import {
  ConfigError,
  HttpError,
  ProviderError,
  ValidationError,
} from "../../../../src/core/errors.js";
import {
  AtlasCloudClient,
  AtlasPredictionFailedError,
  assertPredictionSucceeded,
  terminalPredictionFromError,
} from "../../../../src/providers/atlascloud/client.js";
import {
  BASE,
  FLUX_SCHNELL_SCHEMA,
  TEST_KEY,
  catalog,
  createFakeAtlas,
  envelope,
  prediction,
} from "./fake-atlas.js";

const noSleep = async () => {};

describe("AtlasCloudClient construction", () => {
  it("rejects a missing key with a ConfigError that names the env var", () => {
    expect(() => new AtlasCloudClient({ apiKey: "  " })).toThrow(ConfigError);
    expect(() => new AtlasCloudClient({ apiKey: "" })).toThrow(/ATLASCLOUD_API_KEY/);
  });

  it("defaults to the media base, not the LLM /v1 base", () => {
    const c = new AtlasCloudClient({ apiKey: TEST_KEY });
    expect(c.baseUrl).toBe("https://api.atlascloud.ai/api/v1");
  });

  it("accepts a custom base URL and strips trailing slashes", async () => {
    const { calls, fetch } = createFakeAtlas({
      "POST /model/generateImage": { body: prediction("p1", "processing") },
    });
    const c = new AtlasCloudClient({
      apiKey: TEST_KEY,
      baseUrl: "http://mock.local/api/v1//",
      fetch,
    });
    await c.submit("image", { model: "m/x", prompt: "hi" });
    expect(calls[0]?.url).toBe("http://mock.local/api/v1/model/generateImage");
  });
});

describe("submit", () => {
  it.each([
    ["image", "/model/generateImage"],
    ["video", "/model/generateVideo"],
    ["audio", "/model/generateAudio"],
  ] as const)("posts %s jobs to %s with Bearer auth and a flattened body", async (kind, path) => {
    const { client, calls } = createFakeAtlas({
      [`POST ${path}`]: { body: prediction("abc123", "processing") },
    });
    const res = await client.submit(kind, { model: "vendor/model", prompt: "a cat", seed: 1 });
    expect(res.id).toBe("abc123");
    expect(calls[0]?.url).toBe(`${BASE}${path}`);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(calls[0]?.body).toEqual({ model: "vendor/model", prompt: "a cat", seed: 1 });
  });

  it("requires a model id", async () => {
    const { client } = createFakeAtlas({});
    await expect(client.submit("image", { prompt: "x" })).rejects.toThrow(ValidationError);
  });

  it("fails when the response has no prediction id", async () => {
    const { client } = createFakeAtlas({
      "POST /model/generateImage": { body: envelope({ status: "processing" }) },
    });
    await expect(client.submit("image", { model: "m" })).rejects.toThrow(ProviderError);
  });

  it("surfaces a 400 'not found' for unknown models as HttpError without the key", async () => {
    const { client } = createFakeAtlas({
      "POST /model/generateImage": { status: 400, body: { code: 400, msg: "not found" } },
    });
    const err = await client.submit("image", { model: "nope/nope" }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect(String(err.message)).toContain("not found");
    expect(String(err.message)).not.toContain(TEST_KEY);
  });
});

describe("getPrediction", () => {
  it("GETs /model/prediction/{id} and unwraps data", async () => {
    const { client, calls } = createFakeAtlas({
      "GET /model/prediction/p1": {
        body: prediction("p1", "completed", { outputs: ["https://cdn.test/a.jpeg"] }),
      },
    });
    const p = await client.getPrediction("p1");
    expect(p.status).toBe("completed");
    expect(p.outputs).toEqual(["https://cdn.test/a.jpeg"]);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it("rejects ids that could alter the request path", async () => {
    const { client } = createFakeAtlas({});
    await expect(client.getPrediction("../models")).rejects.toThrow(ValidationError);
    await expect(client.getPrediction("a?b=c")).rejects.toThrow(ValidationError);
  });

  it("returns a failed prediction that Atlas reports as HTTP 500", async () => {
    const { client } = createFakeAtlas({
      "GET /model/prediction/p2": {
        status: 500,
        body: {
          code: 500,
          message: "task failed",
          data: { id: "p2", status: "failed", error: "NSFW input" },
        },
      },
    });
    const p = await client.getPrediction("p2");
    expect(p.status).toBe("failed");
    expect(p.error).toBe("NSFW input");
  });

  it("rethrows a plain 500 without a terminal body", async () => {
    const { client } = createFakeAtlas({
      "GET /model/prediction/p3": { status: 503, body: { code: 503, msg: "busy" } },
    });
    await expect(client.getPrediction("p3")).rejects.toBeInstanceOf(HttpError);
  });
});

describe("terminalPredictionFromError", () => {
  it("recovers a failed status from a truncated body snippet", () => {
    const snippet = `{"code":500,"data":{"id":"p9","status":"failed","error":"bad \\"input\\"","outputs":[...`;
    const p = terminalPredictionFromError(
      new HttpError(500, snippet, `${BASE}/model/prediction/p9`),
      "p9",
    );
    expect(p?.status).toBe("failed");
    expect(p?.error).toBe('bad \\"input\\"');
  });

  it("ignores non-HTTP errors and non-terminal bodies", () => {
    expect(terminalPredictionFromError(new Error("x"), "p")).toBeNull();
    expect(
      terminalPredictionFromError(new HttpError(500, '{"data":{"status":"processing"}}', "u"), "p"),
    ).toBeNull();
  });

  it("only treats 5xx bodies with a data.status verdict as terminal", () => {
    const failedBody = '{"code":429,"data":{"status":"failed","error":"x"}}';
    expect(terminalPredictionFromError(new HttpError(429, failedBody, "u"), "p")).toBeNull();
    expect(terminalPredictionFromError(new HttpError(401, failedBody, "u"), "p")).toBeNull();
    // A gateway or rate-limit body with a top-level status is not a prediction verdict.
    expect(
      terminalPredictionFromError(new HttpError(503, '{"status":"error","msg":"busy"}', "u"), "p"),
    ).toBeNull();
    expect(
      terminalPredictionFromError(
        new HttpError(502, '{"status":"failed","message":"bad gw', "u"),
        "p",
      ),
    ).toBeNull();
  });
});

describe("waitForPrediction", () => {
  it("polls processing -> completed", async () => {
    const { client, calls } = createFakeAtlas({
      "GET /model/prediction/w1": [
        { body: prediction("w1", "processing") },
        { body: prediction("w1", "processing") },
        { body: prediction("w1", "completed", { outputs: ["https://cdn.test/v.mp4"] }) },
      ],
    });
    const p = await client.waitForPrediction("w1", { timeoutMs: 60_000, sleep: noSleep });
    expect(p.status).toBe("completed");
    expect(calls).toHaveLength(3);
  });

  it("stops on a terminal failure instead of reporting success", async () => {
    const { client } = createFakeAtlas({
      "GET /model/prediction/w2": [
        { body: prediction("w2", "processing") },
        { body: prediction("w2", "failed", { error: "Invalid parameter: resolution" }) },
      ],
    });
    const p = await client.waitForPrediction("w2", { timeoutMs: 60_000, sleep: noSleep });
    expect(() => assertPredictionSucceeded(p)).toThrow(AtlasPredictionFailedError);
    expect(() => assertPredictionSucceeded(p)).toThrow(/Invalid parameter: resolution/);
  });

  it("retries 429 honouring Retry-After, and 5xx/network errors", async () => {
    const sleeps: number[] = [];
    const { client } = createFakeAtlas({
      "GET /model/prediction/w3": [
        { status: 429, body: { code: 429, msg: "rate limited" }, headers: { "retry-after": "2" } },
        { status: 502, body: { code: 502, msg: "bad gateway" } },
        { status: -1 },
        { body: prediction("w3", "completed", { outputs: ["https://cdn.test/a.png"] }) },
      ],
    });
    const p = await client.waitForPrediction("w3", {
      timeoutMs: 60_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(p.status).toBe("completed");
    expect(sleeps[0]).toBe(2000);
    expect(sleeps).toHaveLength(3);
  });

  it("retries a 429 whose body carries an error status instead of failing the job", async () => {
    const { client } = createFakeAtlas({
      "GET /model/prediction/w6": [
        { status: 429, body: { status: "error", message: "rate limited" } },
        { body: prediction("w6", "completed", { outputs: ["https://cdn.test/a.png"] }) },
      ],
    });
    const p = await client.waitForPrediction("w6", { timeoutMs: 60_000, sleep: noSleep });
    expect(p.status).toBe("completed");
  });

  it("caps each poll request at the time left before the deadline", async () => {
    const { client } = createFakeAtlas({
      "GET /model/prediction/w7": { body: prediction("w7", "completed") },
    });
    const spy = vi.spyOn(client, "getPrediction");
    await client.waitForPrediction("w7", { timeoutMs: 5000, sleep: noSleep });
    const perPoll = spy.mock.calls[0]?.[1] as number;
    expect(perPoll).toBeGreaterThanOrEqual(1000);
    expect(perPoll).toBeLessThanOrEqual(5000);
  });

  it("does not retry a 401", async () => {
    const { client } = createFakeAtlas({
      "GET /model/prediction/w4": { status: 401, body: { code: 401, msg: "invalid token" } },
    });
    await expect(
      client.waitForPrediction("w4", { timeoutMs: 60_000, sleep: noSleep }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("times out (bounded) with a resume hint", async () => {
    let t = 0;
    const { client } = createFakeAtlas({
      "GET /model/prediction/w5": { body: prediction("w5", "processing") },
    });
    const err = await client
      .waitForPrediction("w5", {
        timeoutMs: 10_000,
        intervalMs: 3000,
        resumeHint: "Resume with: multix atlas status w5 --wait --download",
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect(err.message).toContain("multix atlas status w5");
  });
});

describe("uploadMedia", () => {
  it("posts multipart `file` with Bearer auth and returns data.download_url", async () => {
    let seen: { form?: FormData; headers?: Record<string, string> } = {};
    const fetch = async (_url: string, init?: RequestInit) => {
      seen = { form: init?.body as FormData, headers: init?.headers as Record<string, string> };
      return new Response(
        JSON.stringify(
          envelope({
            download_url: "https://cdn.test/up/photo.png",
            filename: "photo.png",
            size: 3,
          }),
        ),
        { status: 200 },
      );
    };
    const c = new AtlasCloudClient({ apiKey: TEST_KEY, fetch });
    const res = await c.uploadMedia(new Uint8Array([1, 2, 3]), "photo.png", "image/png");
    expect(res.url).toBe("https://cdn.test/up/photo.png");
    expect(seen.headers?.Authorization).toBe(`Bearer ${TEST_KEY}`);
    // Content-Type must be left to fetch so the multipart boundary is set.
    expect(Object.keys(seen.headers ?? {}).map((k) => k.toLowerCase())).not.toContain(
      "content-type",
    );
    const file = seen.form?.get("file") as File;
    expect(file.name).toBe("photo.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(3);
  });

  it("calls the injected fetch without a receiver (Workers reject method calls)", async () => {
    // Mimics workerd: native fetch throws "Illegal invocation" for any other `this`.
    const strictFetch = async function (this: unknown, _url: string, _init?: RequestInit) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Illegal invocation: function called with incorrect `this` reference");
      }
      return new Response(JSON.stringify(envelope({ download_url: "https://cdn.test/w.png" })));
    };
    const c = new AtlasCloudClient({ apiKey: TEST_KEY, fetch: strictFetch });
    expect((await c.uploadMedia(new Uint8Array([1]), "w.png")).url).toBe("https://cdn.test/w.png");
  });

  it("falls back to the documented top-level url", async () => {
    const fetch = async () => new Response(JSON.stringify({ url: "https://cdn.test/x.mp3" }));
    const c = new AtlasCloudClient({ apiKey: TEST_KEY, fetch });
    expect((await c.uploadMedia(new Uint8Array([1]), "x.mp3")).url).toBe("https://cdn.test/x.mp3");
  });

  it("fails clearly when no URL comes back or the upload is rejected", async () => {
    const noUrl = new AtlasCloudClient({
      apiKey: TEST_KEY,
      fetch: async () => new Response(JSON.stringify({ code: 200, data: {} })),
    });
    await expect(noUrl.uploadMedia(new Uint8Array([1]), "a.png")).rejects.toThrow(ProviderError);
    const rejected = new AtlasCloudClient({
      apiKey: TEST_KEY,
      fetch: async () => new Response('{"code":413,"msg":"too large"}', { status: 413 }),
    });
    await expect(rejected.uploadMedia(new Uint8Array([1]), "a.png")).rejects.toMatchObject({
      status: 413,
    });
  });
});

describe("catalog and model schemas", () => {
  it("finds a model by exact id and parses its schema and endpoint", async () => {
    const { client, calls } = createFakeAtlas({
      "GET /models": {
        body: catalog([
          {
            model: "black-forest-labs/flux-schnell",
            type: "Image",
            schema: "https://static.test/flux.json",
          },
        ]),
      },
      "GET /flux.json": { body: FLUX_SCHNELL_SCHEMA },
    });
    const spec = await client.getModelSpec("black-forest-labs/flux-schnell");
    expect(spec?.endpoint).toBe("image");
    expect(spec?.required).toEqual(["model", "prompt"]);
    expect(Object.keys(spec?.properties ?? {})).toContain("num_images");
    // The catalog is public; the key is never sent to it or to the schema host.
    expect(calls.every((c) => c.headers.authorization === undefined)).toBe(true);
    expect(await client.getModelSpec("Black-Forest-Labs/flux-schnell")).toBeUndefined();
    expect(calls.filter((c) => c.url.endsWith("/models"))).toHaveLength(1);
  });

  it("uses a short timeout for catalog and schema lookups", async () => {
    const { client } = createFakeAtlas({
      "GET /models": {
        body: catalog([{ model: "m/x", type: "Image", schema: "https://static.test/x.json" }]),
      },
      "GET /x.json": { body: FLUX_SCHNELL_SCHEMA },
    });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await client.getModelSpec("m/x");
    expect(timeout.mock.calls.map((c) => c[0])).toEqual([15_000, 15_000]);
    timeout.mockRestore();
  });
});
