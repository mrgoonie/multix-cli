import { describe, expect, it } from "vitest";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import { classifyError } from "../../../../src/core/error-classify.js";
import { HttpError, MultixError } from "../../../../src/core/errors.js";
import { SumeClient, jobState } from "../../../../src/providers/sume/client.js";
import { fakeSume, job, json, sumeError } from "./fake-sume.js";

const GEN = "POST /v1/video-router/generate";
const body = { model: "kling-3", prompt: "a cat surfing" };

function client(fetch: typeof globalThis.fetch) {
  return new SumeClient({ apiKey: "sk_test_secret", fetch });
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("SumeClient.submit", () => {
  it("sends one POST with the bearer key and the Idempotency-Key", async () => {
    const { fetch, calls } = fakeSume({
      [GEN]: [
        json({ data: { job: job("job_1", "queued"), status_url: "/v1/jobs/job_1/status" } }, 202),
      ],
    });
    const res = await client(fetch).submit("video", body, "key-123");
    expect(res.job.id).toBe("job_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.authorization).toBe("Bearer sk_test_secret");
    expect(calls[0]?.headers["idempotency-key"]).toBe("key-123");
    expect(calls[0]?.body).toEqual(body);
  });

  it("reports a cut-off submit as unknown remote state and never resends it", async () => {
    const reset = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    });
    const { fetch, calls } = fakeSume({ [GEN]: [reset] });
    const err = await caught(client(fetch).submit("video", body, "key-abc"));
    expect(err).toBeInstanceOf(MultixError);
    expect((err as MultixError).code).toBe("UNKNOWN_REMOTE_STATE");
    expect((err as Error).message).toContain("--idempotency-key key-abc");
    expect(classifyError(err).code).toBe("UNKNOWN_REMOTE_STATE");
    expect(calls).toHaveLength(1);
  });

  it("treats a gateway 5xx without Sume's error body as unknown state", async () => {
    const { fetch, calls } = fakeSume({
      [GEN]: [new Response("<html>Bad gateway</html>", { status: 502 })],
    });
    const err = await caught(client(fetch).submit("video", body, "k1"));
    expect((err as MultixError).code).toBe("UNKNOWN_REMOTE_STATE");
    expect(calls).toHaveLength(1);
  });

  it("treats an accepted response without a job id as unknown state", async () => {
    const { fetch } = fakeSume({ [GEN]: [json({ data: { status_url: "x" } }, 202)] });
    const err = await caught(client(fetch).submit("video", body, "k1"));
    expect((err as MultixError).code).toBe("UNKNOWN_REMOTE_STATE");
  });

  it("maps Sume's own 5xx error body to an HTTP error (nothing was created)", async () => {
    const { fetch } = fakeSume({ [GEN]: [sumeError(503, "provider_unavailable", "busy")] });
    const err = await caught(client(fetch).submit("video", body, "k1"));
    expect(err).toBeInstanceOf(HttpError);
    expect(classifyError(err).code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("classifies 401, 402 insufficient_funds, 403 spend limit and 429", async () => {
    const cases: Array<[Response, string]> = [
      [sumeError(401, "invalid_api_key", "Invalid API key"), "INVALID_KEY"],
      [sumeError(402, "insufficient_funds", "Balance too low"), "QUOTA_EXCEEDED"],
      [sumeError(403, "api_key_spend_limit_exceeded", "Key spend limit reached"), "QUOTA_EXCEEDED"],
      [sumeError(429, "rate_limited", "Slow down", { retry_after_seconds: 9 }), "RATE_LIMITED"],
    ];
    for (const [response, code] of cases) {
      const { fetch, calls } = fakeSume({ [GEN]: [response] });
      const err = await caught(client(fetch).submit("video", body, "k1"));
      expect(classifyError(err).code, code).toBe(code);
      expect(calls).toHaveLength(1);
      expect((err as Error).message).not.toContain("sk_test_secret");
    }
  });

  it("carries retry_after_seconds from a 429 body", async () => {
    const { fetch } = fakeSume({
      [GEN]: [sumeError(429, "rate_limited", "Slow down", { retry_after_seconds: 9 })],
    });
    const err = (await caught(client(fetch).submit("video", body, "k1"))) as HttpError;
    expect(err.retryAfterMs).toBe(9000);
  });

  it("rejects an invalid idempotency key before sending", async () => {
    const { fetch, calls } = fakeSume({});
    await expect(client(fetch).submit("video", body, "has space")).rejects.toThrow(
      /idempotency-key/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("SumeClient.waitForJob", () => {
  it("retries a 429 status read after Retry-After and stops at a terminal state", async () => {
    const status = (s: string, terminal = false) =>
      json({ data: { job_id: "job_1", sume_status: s, terminal } });
    const { fetch, calls } = fakeSume({
      "GET /v1/jobs/job_1/status": [
        status("queued"),
        new Response(JSON.stringify({ error: { code: "rate_limited", message: "x" } }), {
          status: 429,
          headers: { "Retry-After": "7" },
        }),
        status("completed", true),
      ],
    });
    const sleeps: number[] = [];
    const final = await client(fetch).waitForJob("job_1", {
      timeoutMs: 600_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(jobState(final)).toBe("completed");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls).toHaveLength(3);
    expect(sleeps).toContain(7000);
  });

  it("times out with the resume hint when the job never finishes", async () => {
    const { fetch } = fakeSume({
      "GET /v1/jobs/job_1/status": [json({ data: { sume_status: "processing" } })],
    });
    let t = 0;
    const err = await caught(
      client(fetch).waitForJob("job_1", {
        timeoutMs: 10_000,
        resumeHint: "Resume with: multix sume status job_1 --wait --download",
        sleep: async (ms) => {
          t += ms;
        },
        now: () => t,
      }),
    );
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect((err as Error).message).toContain("multix sume status job_1");
  });

  it("refuses a malformed job id without a request", async () => {
    const { fetch, calls } = fakeSume({});
    await expect(client(fetch).getStatus("../etc")).rejects.toThrow(/Invalid Sume job id/);
    expect(calls).toHaveLength(0);
  });
});

describe("SumeClient result, cancel, estimate, upload", () => {
  it("keeps only artifacts with a URL", async () => {
    const { fetch } = fakeSume({
      "GET /v1/jobs/job_1/result": [
        json({
          data: {
            job_id: "job_1",
            result: { artifacts: [{ url: "https://cdn.sume.com/a.mp4" }, { id: "no-url" }] },
          },
        }),
      ],
    });
    const result = await client(fetch).getResult("job_1");
    expect(result.artifacts).toEqual([{ url: "https://cdn.sume.com/a.mp4" }]);
  });

  it("sends cancel once and surfaces a 409 when it is too late", async () => {
    const { fetch, calls } = fakeSume({
      "POST /v1/jobs/job_1/cancel": [sumeError(409, "job_not_cancelable", "Already running")],
    });
    const err = await caught(client(fetch).cancel("job_1"));
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it("requires usd_micros from the estimate endpoint", async () => {
    const { fetch } = fakeSume({ "POST /v1/open/estimate": [json({ data: { usd: "0.1" } })] });
    await expect(client(fetch).estimate("kling-3", {})).rejects.toThrow(/usd_micros/);
  });

  it("PUTs upload bytes without the API key and hides the signed query on failure", async () => {
    const signed = "https://uploads.sume.com/obj?X-Amz-Signature=secret-sig";
    const { fetch, calls } = fakeSume({
      "POST /v1/files/generate-upload-url": [
        json({
          data: {
            public_url: "https://cdn.sume.com/obj.png",
            upload_url: signed,
            upload_method: "PUT",
            upload_headers: { "Content-Type": "image/png", Authorization: "nope" },
          },
        }),
      ],
      "PUT /obj": [new Response("denied", { status: 403 })],
    });
    const c = client(fetch);
    const target = await c.createUpload({ contentType: "image/png", sizeBytes: 3 });
    const err = await caught(c.putUpload(target, new Uint8Array([1, 2, 3])));
    const put = calls.find((x) => x.method === "PUT");
    expect(put?.headers.authorization).toBeUndefined();
    expect(put?.headers["content-type"]).toBe("image/png");
    expect((err as Error).message).not.toContain("secret-sig");
  });
});
