import { describe, expect, it } from "vitest";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import {
  ReplicateApiError,
  ReplicateClient,
  ReplicatePredictionError,
  assertSucceeded,
} from "../../../../src/providers/replicate/client.js";
import { parseModelRef } from "../../../../src/providers/replicate/models.js";
import type { ReplicatePrediction } from "../../../../src/providers/replicate/types.js";
import { BASE, TOKEN, createFakeReplicate, noSleep, prediction } from "./fake-replicate.js";

const VERSION = "c846a69991daf4c0e5d016514849d14ee5b2e6846ce6b9d6f21369e564cfe51e";

function client(fake: ReturnType<typeof createFakeReplicate>) {
  return new ReplicateClient({ apiKey: TOKEN, baseUrl: BASE, fetch: fake.fetch, sleep: noSleep });
}

describe("ReplicateClient.createPrediction — official model endpoint", () => {
  it("posts { input } to /models/{owner}/{name}/predictions with Bearer auth", async () => {
    const fake = createFakeReplicate({
      "POST /models/black-forest-labs/flux-schnell/predictions": [
        { status: 201, json: prediction("abc123", "starting") },
      ],
    });
    const p = await client(fake).createPrediction({
      model: parseModelRef("black-forest-labs/flux-schnell"),
      input: { prompt: "cube" },
    });
    expect(p.id).toBe("abc123");
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.url).toBe(`${BASE}/models/black-forest-labs/flux-schnell/predictions`);
    expect(call?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call?.body).toEqual({ input: { prompt: "cube" } });
    expect(call?.headers.prefer).toBeUndefined();
  });
});

describe("ReplicateClient.createPrediction — versioned endpoint", () => {
  it("posts { version, input } to /predictions for owner/name:version", async () => {
    const fake = createFakeReplicate({
      "POST /predictions": [{ status: 201, json: prediction("ver1", "starting") }],
    });
    await client(fake).createPrediction({
      model: parseModelRef(`someone/community-model:${VERSION}`),
      input: { prompt: "x" },
    });
    expect(fake.calls[0]?.url).toBe(`${BASE}/predictions`);
    expect(fake.calls[0]?.body).toEqual({ version: VERSION, input: { prompt: "x" } });
  });

  it("uses the versioned endpoint for a bare version id and for --version", async () => {
    const fake = createFakeReplicate({
      "POST /predictions": [{ status: 201, json: prediction("ver2", "starting") }],
    });
    const c = client(fake);
    await c.createPrediction({ model: parseModelRef(VERSION), input: {} });
    await c.createPrediction({ model: parseModelRef("owner/name", VERSION), input: {} });
    expect(fake.calls.map((x) => x.url)).toEqual([`${BASE}/predictions`, `${BASE}/predictions`]);
    expect(fake.calls.every((x) => (x.body as { version: string }).version === VERSION)).toBe(true);
  });
});

describe("Prefer: wait", () => {
  it("sends Prefer: wait=N and keeps polling when the response is still nonterminal", async () => {
    const fake = createFakeReplicate({
      "POST /models/o/m/predictions": [{ status: 201, json: prediction("pw1", "processing") }],
      "GET /predictions/pw1": [
        { json: prediction("pw1", "processing") },
        { json: prediction("pw1", "succeeded", { output: "https://replicate.delivery/a.png" }) },
      ],
    });
    const c = client(fake);
    const created = await c.createPrediction({
      model: parseModelRef("o/m"),
      input: {},
      preferWaitSeconds: 30,
    });
    expect(fake.calls[0]?.headers.prefer).toBe("wait=30");
    expect(created.status).toBe("processing");
    const final = await c.waitForPrediction(created, { timeoutMs: 60_000, sleep: noSleep });
    expect(final.status).toBe("succeeded");
    expect(fake.calls.filter((x) => x.method === "GET")).toHaveLength(2);
  });

  it("clamps the wait to 1..60 seconds and skips polling for a terminal response", async () => {
    const fake = createFakeReplicate({
      "POST /models/o/m/predictions": [{ status: 201, json: prediction("pw2", "succeeded") }],
    });
    const c = client(fake);
    const created = await c.createPrediction({
      model: parseModelRef("o/m"),
      input: {},
      preferWaitSeconds: 600,
    });
    expect(fake.calls[0]?.headers.prefer).toBe("wait=60");
    const final = await c.waitForPrediction(created, { timeoutMs: 1000 });
    expect(final).toBe(created);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("waitForPrediction and terminal states", () => {
  it("polls starting → processing → succeeded", async () => {
    const fake = createFakeReplicate({
      "GET /predictions/p1": [
        { json: prediction("p1", "starting") },
        { json: prediction("p1", "processing") },
        { json: prediction("p1", "succeeded", { output: ["https://x/1.png"] }) },
      ],
    });
    const seen: string[] = [];
    const final = await client(fake).waitForPrediction("p1", {
      timeoutMs: 60_000,
      onPoll: (p) => seen.push(p.status),
    });
    expect(seen).toEqual(["starting", "processing", "succeeded"]);
    expect(assertSucceeded(final).output).toEqual(["https://x/1.png"]);
  });

  it.each(["failed", "canceled", "aborted"])(
    "treats %s as terminal and assertSucceeded throws with the provider error",
    async (status) => {
      const fake = createFakeReplicate({
        "GET /predictions/p2": [
          { json: prediction("p2", status, { error: "CUDA out of memory" }) },
        ],
      });
      const final = await client(fake).waitForPrediction("p2", { timeoutMs: 60_000 });
      expect(final.status).toBe(status);
      expect(() => assertSucceeded(final)).toThrow(ReplicatePredictionError);
      expect(() => assertSucceeded(final)).toThrow(`p2 ${status}: CUDA out of memory`);
    },
  );

  it("does not treat a nonterminal prediction with output as success", () => {
    const p = prediction("p3", "processing", { output: "https://x/partial.mp4" });
    expect(() => assertSucceeded(p as ReplicatePrediction)).toThrow(/not finished/);
  });

  it("retries 429 (honouring Retry-After) and 5xx while polling", async () => {
    const delays: number[] = [];
    const fake = createFakeReplicate({
      "GET /predictions/p4": [
        { status: 429, text: "slow", headers: { "retry-after": "3" } },
        { status: 503, text: "down" },
        { json: prediction("p4", "succeeded") },
      ],
    });
    const final = await client(fake).waitForPrediction("p4", {
      timeoutMs: 60_000,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(final.status).toBe("succeeded");
    expect(delays[0]).toBe(3000);
  });

  it("times out with a PollTimeoutError carrying the resume hint", async () => {
    let t = 0;
    const fake = createFakeReplicate({
      "GET /predictions/p5": [{ json: prediction("p5", "processing") }],
    });
    const promise = client(fake).waitForPrediction("p5", {
      timeoutMs: 10_000,
      resumeHint: "Resume with: multix replicate status p5 --wait --download",
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    await expect(promise).rejects.toThrow(PollTimeoutError);
    await expect(promise).rejects.toThrow(/multix replicate status p5/);
  });

  it("maps a non-transient poll failure to an actionable error", async () => {
    const fake = createFakeReplicate({
      "GET /predictions/p6": [{ status: 404, json: { detail: "Not found." } }],
    });
    await expect(client(fake).waitForPrediction("p6", { timeoutMs: 1000 })).rejects.toThrow(
      /could not find prediction p6 \(404\)/,
    );
  });

  it("rejects malformed prediction responses", async () => {
    const fake = createFakeReplicate({ "GET /predictions/p7": [{ json: { hello: "world" } }] });
    await expect(client(fake).getPrediction("p7")).rejects.toThrow(/Malformed Replicate response/);
  });

  it("rejects server-supplied prediction ids that could traverse paths", async () => {
    const fake = createFakeReplicate({
      "POST /models/o/m/predictions": [
        { status: 201, json: prediction("/../../x", "succeeded", { output: "https://r/1.png" }) },
      ],
    });
    await expect(
      client(fake).createPrediction({ model: parseModelRef("o/m"), input: {} }),
    ).rejects.toThrow(/invalid prediction id/);
  });

  it("rejects prediction ids that could alter the request path", async () => {
    const fake = createFakeReplicate({});
    await expect(client(fake).getPrediction("../models")).rejects.toThrow(/Invalid Replicate/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("cancelPrediction", () => {
  it("posts to /predictions/{id}/cancel", async () => {
    const fake = createFakeReplicate({
      "POST /predictions/c1/cancel": [{ json: prediction("c1", "canceled") }],
    });
    const p = await client(fake).cancelPrediction("c1");
    expect(p.status).toBe("canceled");
    expect(fake.calls[0]?.url).toBe(`${BASE}/predictions/c1/cancel`);
    expect(fake.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("HTTP error mapping", () => {
  const cases: Array<[number, RegExp]> = [
    [401, /rejected the API token \(401\).*REPLICATE_API_TOKEN/],
    [403, /denied access to model o\/m \(403\)/],
    [404, /could not find model o\/m \(404\).*explicit version/],
    [422, /rejected the input for model o\/m \(422\): prompt is required/],
    [500, /server error \(500\)/],
  ];
  it.each(cases)("maps %i to an actionable message without leaking the token", async (s, re) => {
    const fake = createFakeReplicate({
      "POST /models/o/m/predictions": [{ status: s, json: { detail: "prompt is required" } }],
    });
    const err = await client(fake)
      .createPrediction({ model: parseModelRef("o/m"), input: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReplicateApiError);
    expect((err as ReplicateApiError).status).toBe(s);
    expect((err as Error).message).toMatch(re);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("retries create on 429 using Retry-After, then succeeds", async () => {
    const delays: number[] = [];
    const fake = createFakeReplicate({
      "POST /models/o/m/predictions": [
        { status: 429, text: "throttled", headers: { "retry-after": "2" } },
        { status: 201, json: prediction("r1", "starting") },
      ],
    });
    const c = new ReplicateClient({
      apiKey: TOKEN,
      baseUrl: BASE,
      fetch: fake.fetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const p = await c.createPrediction({ model: parseModelRef("o/m"), input: {} });
    expect(p.id).toBe("r1");
    expect(delays).toEqual([2000]);
  });

  it("surfaces 429 with the retry-after hint once retries are exhausted", async () => {
    const fake = createFakeReplicate({
      "POST /models/o/m/predictions": [
        { status: 429, text: "throttled", headers: { "retry-after": "7" } },
      ],
    });
    const err = (await client(fake)
      .createPrediction({ model: parseModelRef("o/m"), input: {} })
      .catch((e: unknown) => e)) as ReplicateApiError;
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(7000);
    expect(err.message).toMatch(/rate limit reached \(429\); retry after 7s/);
    expect(fake.calls).toHaveLength(3);
  });

  it("reports network failures as status 0", async () => {
    const fake = createFakeReplicate({
      "POST /models/o/m/predictions": [{ throws: new Error("ECONNRESET") }],
    });
    await expect(
      client(fake).createPrediction({ model: parseModelRef("o/m"), input: {} }),
    ).rejects.toThrow(/Network error contacting Replicate: ECONNRESET/);
  });

  it.each([
    [
      "a network error or timeout",
      { throws: new Error("The operation was aborted due to timeout") },
    ],
    ["a 5xx", { status: 502, text: "bad gateway" }],
  ] as const)("warns about a possibly orphaned prediction after %s on create", async (_, res) => {
    const fake = createFakeReplicate({ "POST /models/o/m/predictions": [res] });
    await expect(
      client(fake).createPrediction({ model: parseModelRef("o/m"), input: {} }),
    ).rejects.toThrow(/may have been created anyway.*replicate\.com\/predictions before retrying/);
  });

  it("does not add the orphan hint to client errors or to status checks", async () => {
    const fake = createFakeReplicate({
      "POST /models/o/m/predictions": [{ status: 422, json: { detail: "bad" } }],
      "GET /predictions/p1": [{ throws: new Error("ECONNRESET") }],
    });
    const create = await client(fake)
      .createPrediction({ model: parseModelRef("o/m"), input: {} })
      .catch((e: unknown) => e as Error);
    expect(create.message).not.toContain("created anyway");
    const get = await client(fake)
      .getPrediction("p1")
      .catch((e: unknown) => e as Error);
    expect(get.message).not.toContain("created anyway");
  });
});

describe("uploadFile", () => {
  it("sends multipart content to /files and returns urls.get", async () => {
    const fake = createFakeReplicate({
      "POST /files": [
        {
          status: 201,
          json: {
            id: "f1",
            content_type: "image/png",
            size: 4,
            urls: { get: `${BASE}/files/f1` },
          },
        },
      ],
    });
    const file = await client(fake).uploadFile({
      data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
      filename: "a.png",
      contentType: "image/png",
    });
    expect(file.urls.get).toBe(`${BASE}/files/f1`);
    const form = fake.calls[0]?.rawBody as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect((form.get("content") as File).name).toBe("a.png");
    expect(form.get("type")).toBe("image/png");
    expect(fake.calls[0]?.headers["content-type"]).toBeUndefined();
  });

  it("explains the 100MB limit on 413", async () => {
    const fake = createFakeReplicate({ "POST /files": [{ status: 413, text: "too big" }] });
    await expect(
      client(fake).uploadFile({ data: new Blob(["x"]), filename: "a.bin", contentType: "x/y" }),
    ).rejects.toThrow(/less than 100MB/);
  });
});
