/**
 * Sume client against an in-memory fake API: Bearer auth, idempotency keys
 * reused across retries, no retry of definite refusals, error mapping, key
 * scrubbing, job id validation, polling and the key-free upload PUT.
 */

import { describe, expect, it } from "vitest";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import { ValidationError } from "../../../../src/core/errors.js";
import { SUBMIT_MAX_RETRIES, SumeClient, parseJob } from "../../../../src/providers/sume/client.js";
import { SumeApiError, SumeSubmitError } from "../../../../src/providers/sume/errors.js";
import {
  BASE,
  JOB_ID,
  KEY,
  UPLOAD_URL,
  apiError,
  createFakeSume,
  result,
  status,
  submitted,
} from "./fake-sume.js";

const IMAGE = "POST /v1/image-router/generate";
const STATUS = `GET /v1/jobs/${JOB_ID}/status`;
const IDEM = "11111111-2222-4333-8444-555555555555";
const BODY = { model: "gpt-image-2", prompt: "a red cup" };

function client(routes: Parameters<typeof createFakeSume>[0], extra = {}) {
  const fake = createFakeSume(routes);
  const sleeps: number[] = [];
  const c = new SumeClient({
    apiKey: KEY,
    baseUrl: BASE,
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { c, fake, sleeps };
}

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("SumeClient submit", () => {
  it("sends Bearer auth and the idempotency key, and parses the job and charge", async () => {
    const { c, fake } = client({ [IMAGE]: [{ status: 202, json: submitted() }] });
    const out = await c.generateImage(BODY, { idempotencyKey: IDEM });
    expect(out.job).toMatchObject({ id: JOB_ID, status: "queued", terminal: false });
    expect(out.usageUsd).toBe("0.79");
    expect(out.idempotencyHit).toBe(false);
    const [call] = fake.calls;
    expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call?.headers["idempotency-key"]).toBe(IDEM);
    expect(call?.headers["x-api-key"]).toBeUndefined();
    expect(call?.body).toEqual(BODY);
  });

  it("posts video requests to the video router", async () => {
    const { c, fake } = client({
      "POST /v1/video-router/generate": [{ status: 202, json: submitted() }],
    });
    await c.generateVideo({ model: "kling-4", prompt: "waves" }, { idempotencyKey: IDEM });
    expect(fake.calls[0]?.url).toBe(`${BASE}/v1/video-router/generate`);
  });

  it("reports an idempotency hit", async () => {
    const { c } = client({ [IMAGE]: [{ json: submitted({ idempotency_hit: true }) }] });
    expect((await c.generateImage(BODY, { idempotencyKey: IDEM })).idempotencyHit).toBe(true);
  });

  it("reuses the same key across queue_full, network and retryable 5xx retries", async () => {
    const retries: string[] = [];
    const { c, fake, sleeps } = client({
      [IMAGE]: [
        { status: 429, json: apiError("queue_full", { retry_after_seconds: 5 }) },
        { throws: new TypeError("fetch failed") },
        { status: 503, json: apiError("upstream_unavailable", { retryable: true }) },
        { status: 202, json: submitted() },
      ],
    });
    await c.generateImage(BODY, {
      idempotencyKey: IDEM,
      onRetry: (_n, _d, reason) => retries.push(reason),
    });
    expect(fake.calls).toHaveLength(4);
    expect(new Set(fake.calls.map((x) => x.headers["idempotency-key"]))).toEqual(new Set([IDEM]));
    expect(sleeps[0]).toBe(5000);
    expect(retries).toEqual(["queue_full", "network error", "upstream_unavailable"]);
  });

  it.each([
    [402, "insufficient_funds"],
    [403, "forbidden"],
    [400, "invalid_request"],
    [409, "idempotency_conflict"],
    [500, "provider_submission_failed"],
  ])("never retries a %i %s", async (code, name) => {
    const { c, fake } = client({ [IMAGE]: [{ status: code, json: apiError(name) }] });
    const error = await failure(c.generateImage(BODY, { idempotencyKey: IDEM }));
    expect(fake.calls).toHaveLength(1);
    expect(error).toBeInstanceOf(SumeApiError);
    expect((error as SumeApiError).status).toBe(code);
  });

  it("names the key and the safe retry command when retries run out ambiguously", async () => {
    const { c, fake } = client({ [IMAGE]: [{ throws: new TypeError("fetch failed") }] });
    const error = await failure(
      c.generateImage(BODY, {
        idempotencyKey: IDEM,
        retryCommand: (k) => `multix sume image x -m gpt-image-2 --idempotency-key ${k}`,
      }),
    );
    expect(fake.calls).toHaveLength(SUBMIT_MAX_RETRIES + 1);
    expect(error).toBeInstanceOf(SumeSubmitError);
    expect((error as SumeSubmitError).ambiguous).toBe(true);
    expect(error.message).toContain(`Do not resubmit without the same idempotency key (${IDEM})`);
    expect(error.message).toContain(`--idempotency-key ${IDEM}`);
  });

  it("keeps a definite queue_full refusal unambiguous", async () => {
    const { c } = client({ [IMAGE]: [{ status: 429, json: apiError("queue_full") }] });
    const error = await failure(c.generateImage(BODY, { idempotencyKey: IDEM }));
    expect(error).toBeInstanceOf(SumeApiError);
    expect(error.message).toContain("queue_full");
    expect(error.message).toContain("same --idempotency-key");
  });

  it("treats an unreadable 2xx as ambiguous", async () => {
    const { c } = client({ [IMAGE]: [{ status: 202, json: { data: {} } }] });
    const error = await failure(c.generateImage(BODY, { idempotencyKey: IDEM }));
    expect(error).toBeInstanceOf(SumeSubmitError);
    expect(error.message).toContain(IDEM);
  });

  it("rejects an invalid idempotency key before any request", async () => {
    const { c, fake } = client({});
    await expect(c.generateImage(BODY, { idempotencyKey: "bad\nkey" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fake.calls).toHaveLength(0);
  });
});

describe("SumeClient error mapping", () => {
  it("includes required and available USD on 402", async () => {
    const { c } = client({
      [IMAGE]: [
        {
          status: 402,
          json: apiError("insufficient_funds", {
            details: { required_usd: "0.79", available_usd: "0.10" },
          }),
        },
      ],
    });
    const error = await failure(c.generateImage(BODY, { idempotencyKey: IDEM }));
    expect(error.message).toContain("needs $0.79, available $0.10");
    expect(error.message).toContain("Nothing was charged");
    expect(error.message).toContain("(request req_123)");
  });

  it("lists validation paths on 400", async () => {
    const { c } = client({
      [IMAGE]: [
        {
          status: 400,
          json: apiError("invalid_request", {
            details: { errors: [{ path: "input.num_images", message: "must be <= 4" }] },
          }),
        },
      ],
    });
    const error = await failure(c.generateImage(BODY, { idempotencyKey: IDEM }));
    expect(error.message).toContain("- input.num_images: must be <= 4");
  });

  it("points a 401 at the dashboard and a 404 model at `multix sume models`", async () => {
    const one = client({ [IMAGE]: [{ status: 401, json: apiError("unauthorized") }] });
    expect((await failure(one.c.generateImage(BODY, { idempotencyKey: IDEM }))).message).toMatch(
      /SUME_API_KEY.*sume\.com\/docs/,
    );
    const two = client({ [IMAGE]: [{ status: 404, json: apiError("model_not_found") }] });
    expect((await failure(two.c.generateImage(BODY, { idempotencyKey: IDEM }))).message).toContain(
      "multix sume models",
    );
  });

  it("parses a truncated error snippet", async () => {
    const long = JSON.stringify(
      apiError("insufficient_funds", {
        details: { required_usd: "2.50", available_usd: "1.00", pad: "x".repeat(800) },
      }),
    );
    const { c } = client({ [IMAGE]: [{ status: 402, text: long }] });
    const error = await failure(c.generateImage(BODY, { idempotencyKey: IDEM }));
    expect(error.message).toContain("needs $2.50, available $1.00");
  });

  it("scrubs the key from an echoed error body", async () => {
    const { c } = client({
      [STATUS]: [{ status: 400, text: `bad header Authorization: Bearer ${KEY}` }],
    });
    const error = await failure(c.getStatus(JOB_ID));
    expect(error.message).not.toContain(KEY);
    expect(error.message).toContain("[redacted]");
    expect(JSON.stringify(error.cause ?? null)).not.toContain(KEY);
  });

  it("maps 409 cancel conflicts", async () => {
    const { c } = client({
      [`POST /v1/jobs/${JOB_ID}/cancel`]: [
        { status: 409, json: apiError("job_generation_already_started") },
      ],
    });
    const error = await failure(c.cancel(JOB_ID));
    expect(error.message).toContain("can no longer be canceled");
  });
});

describe("SumeClient jobs", () => {
  it.each(["job_123", "../v1/x", `${JOB_ID}/../../`, "job_0f0e0d0c-1111-4222-8333-44445555666"])(
    "rejects job id %s without a request",
    async (id) => {
      const { c, fake } = client({});
      await expect(c.getStatus(id)).rejects.toBeInstanceOf(ValidationError);
      expect(fake.calls).toHaveLength(0);
    },
  );

  it("normalizes status aliases", () => {
    expect(parseJob({ job_id: JOB_ID, status: "IN_PROGRESS" }).status).toBe("processing");
    expect(parseJob({ job_id: JOB_ID, status: "cancelled" }).terminal).toBe(true);
    expect(() => parseJob({ job_id: JOB_ID, status: "weird" })).toThrow(/Malformed/);
  });

  it("rejects a status response for another job", async () => {
    const other = "job_aaaaaaaa-1111-4222-8333-444455556666";
    const { c } = client({
      [STATUS]: [{ json: { data: { job_id: other, sume_status: "queued" } } }],
    });
    await expect(c.getStatus(JOB_ID)).rejects.toThrow(/does not match/);
  });

  it("reads result artifacts", async () => {
    const { c } = client({ [`GET /v1/jobs/${JOB_ID}/result`]: [{ json: result() }] });
    expect((await c.getResult(JOB_ID)).artifacts).toHaveLength(1);
  });

  it("waits next_poll_after_seconds (at least 2 s) and returns the terminal job", async () => {
    const { c, sleeps } = client({
      [STATUS]: [
        { json: status("queued", { next_poll_after_seconds: 0, queue_position: 3 }) },
        { status: 503, text: "" },
        { json: status("processing", { next_poll_after_seconds: 7 }) },
        { json: status("completed") },
      ],
    });
    const job = await c.waitForJob(JOB_ID, { timeoutMs: 600_000 });
    expect(job.status).toBe("completed");
    expect(sleeps[0]).toBe(2000);
    expect(sleeps[2]).toBe(7000);
  });

  it("times out with the resume hint and the last status", async () => {
    let t = 0;
    const { c } = client(
      { [STATUS]: [{ json: status("processing") }] },
      {
        now: () => t,
        sleep: async (ms: number) => {
          t += ms;
        },
      },
    );
    const error = await failure(
      c.waitForJob(JOB_ID, { timeoutMs: 5000, resumeHint: "Resume with: multix sume status x" }),
    );
    expect(error).toBeInstanceOf(PollTimeoutError);
    expect(error.message).toContain("last status: processing");
    expect(error.message).toContain("Resume with: multix sume status x");
  });

  it("stops polling on a non-transient error", async () => {
    const { c } = client({ [STATUS]: [{ status: 404, json: apiError("job_not_found") }] });
    await expect(c.waitForJob(JOB_ID, { timeoutMs: 60_000 })).rejects.toBeInstanceOf(SumeApiError);
  });
});

describe("SumeClient upload", () => {
  const TICKET = {
    data: {
      public_url: "https://media.sume.test/u/cup.png",
      upload_url: UPLOAD_URL,
      upload_method: "PUT",
      upload_headers: { "content-type": "image/png", "content-length": "3" },
      asset_id: "asset_1",
    },
  };

  it("PUTs the bytes without the key, with manual redirects, and returns the public URL", async () => {
    const { c, fake } = client({
      "POST /v1/files/generate-upload-url": [{ status: 201, json: TICKET }],
      [`PUT ${UPLOAD_URL}`]: [{ status: 200, text: "" }],
    });
    const url = await c.upload({
      data: new Blob([new Uint8Array([1, 2, 3])]),
      filename: "cup.png",
      contentType: "image/png",
    });
    expect(url).toBe("https://media.sume.test/u/cup.png");
    expect(fake.calls[0]?.body).toEqual({
      content_type: "image/png",
      size_bytes: 3,
      filename: "cup.png",
    });
    const put = fake.calls[1];
    expect(put?.headers.authorization).toBeUndefined();
    expect(put?.headers).toEqual({ "content-type": "image/png" });
    expect(put?.redirect).toBe("manual");
  });

  it("refuses a non-public upload URL and keeps the signature out of errors", async () => {
    const internal = {
      data: { ...TICKET.data, upload_url: "https://127.0.0.1/put?X-Signature=SIGNED" },
    };
    const { c, fake } = client({
      "POST /v1/files/generate-upload-url": [{ status: 201, json: internal }],
    });
    const error = await failure(
      c.upload({ data: new Blob(["x"]), filename: "a.png", contentType: "image/png" }),
    );
    expect(error.message).not.toContain("SIGNED");
    expect(fake.calls).toHaveLength(1);
  });

  it("names only the host when the PUT fails", async () => {
    const { c } = client({
      "POST /v1/files/generate-upload-url": [{ status: 201, json: TICKET }],
      [`PUT ${UPLOAD_URL}`]: [{ status: 403, text: "denied" }],
    });
    const error = await failure(
      c.upload({ data: new Blob(["x"]), filename: "a.png", contentType: "image/png" }),
    );
    expect(error.message).not.toContain("SIGNED_PUT_456");
  });
});

it("requires an API key", () => {
  expect(() => new SumeClient({ apiKey: "" })).toThrow(/key is required/);
});
