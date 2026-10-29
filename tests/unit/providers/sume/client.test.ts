/**
 * SumeClient against the in-memory fake API: auth header, idempotent submit
 * retries, error mapping, secret scrubbing, malformed responses, polling,
 * cancel and uploads. No network.
 */

import { describe, expect, it, vi } from "vitest";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import {
  SumeApiError,
  SumeClient,
  SumeMalformedResponseError,
} from "../../../../src/providers/sume/client.js";
import { parseCatalog } from "../../../../src/providers/sume/models.js";
import {
  BASE,
  JOB_ID,
  KEY,
  PUBLIC_URL,
  UPLOAD_URL,
  catalogBody,
  createFakeSume,
  noSleep,
  status,
  submitted,
  sumeError,
} from "./fake-sume.js";

const GENERATE = "POST /v1/image-router/generate";
const STATUS = `GET /v1/jobs/${JOB_ID}/status`;
const BODY = { model: "nano-banana-2.1", prompt: "a cat" };

function client(
  routes: Parameters<typeof createFakeSume>[0],
  extra: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
) {
  const fake = createFakeSume(routes);
  return {
    fake,
    client: new SumeClient({
      apiKey: KEY,
      baseUrl: BASE,
      fetch: fake.fetch,
      sleep: extra.sleep ?? noSleep,
      now: extra.now,
    }),
  };
}

describe("auth", () => {
  it("sends only Authorization: Bearer, and no key to the public catalog", async () => {
    const { fake, client: c } = client({
      [GENERATE]: [{ status: 202, json: submitted() }],
      "GET /v1/open/catalog": [{ json: catalogBody() }],
    });
    await c.generate("image", BODY, { idempotencyKey: "k-1" });
    await c.catalog();
    const [submit, catalog] = fake.calls;
    expect(submit?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(submit?.headers["x-api-key"]).toBeUndefined();
    expect(submit?.headers["idempotency-key"]).toBe("k-1");
    expect(catalog?.headers.authorization).toBeUndefined();
  });

  it("refuses a keyed call without a key, before any request", async () => {
    const fake = createFakeSume({});
    const c = new SumeClient({ baseUrl: BASE, fetch: fake.fetch });
    await expect(c.getStatus(JOB_ID)).rejects.toThrow(/SUME_API_KEY/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("generate: idempotent retries", () => {
  it("parses the job, its reserved charge and status", async () => {
    const { client: c } = client({ [GENERATE]: [{ status: 202, json: submitted() }] });
    const job = await c.generate("image", BODY, { idempotencyKey: "k-1" });
    expect(job).toMatchObject({
      jobId: JOB_ID,
      status: "queued",
      terminal: false,
      cancelable: true,
      idempotencyHit: false,
      idempotencyKey: "k-1",
      usageUsd: "0.35",
      nextPollAfterSeconds: 2,
    });
  });

  it("retries a 503, a network error and a malformed body with the same key", async () => {
    const { fake, client: c } = client({
      [GENERATE]: [
        { status: 503, json: sumeError("provider_capacity_exceeded", "busy") },
        { throws: new TypeError("fetch failed") },
        { status: 202, json: submitted() },
      ],
    });
    await c.generate("image", BODY);
    expect(fake.calls).toHaveLength(3);
    const keys = new Set(fake.calls.map((call) => call.headers["idempotency-key"]));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(/^multix-[0-9a-f-]{36}$/);
  });

  it("honours Retry-After on 429 (capped at 30s)", async () => {
    const sleep = vi.fn(noSleep);
    const { fake, client: c } = client(
      {
        [GENERATE]: [
          {
            status: 429,
            json: sumeError("rate_limited", "slow down"),
            headers: { "retry-after": "5" },
          },
          {
            status: 429,
            json: sumeError("rate_limited", "slow down"),
            headers: { "retry-after": "999" },
          },
          { status: 202, json: submitted() },
        ],
      },
      { sleep },
    );
    await c.generate("image", BODY, { idempotencyKey: "k-2" });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5_000, 30_000]);
    expect(fake.calls.every((call) => call.headers["idempotency-key"] === "k-2")).toBe(true);
  });

  it("gives up after two retries with an orphan hint naming the key", async () => {
    const { fake, client: c } = client({
      [GENERATE]: [{ status: 502, json: sumeError("provider_submission_failed", "upstream") }],
    });
    const error = await c.generate("image", BODY, { idempotencyKey: "k-3" }).catch((e) => e);
    expect(fake.calls).toHaveLength(3);
    expect(error).toBeInstanceOf(SumeApiError);
    expect(error.message).toContain('--idempotency-key "k-3"');
    expect(error.message).toContain("https://app.sume.com");
  });

  it("flags a malformed 2xx (no job id) as possibly created", async () => {
    const { client: c } = client({ [GENERATE]: [{ status: 202, json: { data: { ok: true } } }] });
    const error = await c.generate("image", BODY, { idempotencyKey: "k-4" }).catch((e) => e);
    expect(error.message).toMatch(/Malformed Sume response/);
    expect(error.message).toContain('--idempotency-key "k-4"');
  });

  it.each([
    [
      402,
      "insufficient_funds",
      { required_usd: "0.29", available_usd: "0.10" },
      /balance is too low.*needs \$0\.29, balance \$0\.10.*Nothing was charged/,
    ],
    [
      403,
      "api_key_spend_limit_exceeded",
      { limit_usd: "5.00" },
      /spend limit reached.*limit \$5\.00.*Nothing was charged/,
    ],
    [
      400,
      "invalid_request",
      undefined,
      /rejected the request.*400 invalid_request.*Nothing was charged/,
    ],
    [422, "unsupported_input", undefined, /rejected the request.*422/],
  ])("does not retry a final %i", async (code, sumeCode, details, message) => {
    const { fake, client: c } = client({
      [GENERATE]: [{ status: code, json: sumeError(sumeCode, "no", details) }],
    });
    const error = await c.generate("image", BODY).catch((e) => e);
    expect(fake.calls).toHaveLength(1);
    expect(error).toBeInstanceOf(SumeApiError);
    expect(error.status).toBe(code);
    expect(error.message).toMatch(message);
    expect(error.message).not.toContain("idempotency-key");
  });

  it("maps 409 idempotency_conflict to the job that owns the key", async () => {
    const { fake, client: c } = client({
      [GENERATE]: [
        {
          status: 409,
          json: sumeError("idempotency_conflict", "different body", { job_id: JOB_ID }),
        },
      ],
    });
    const error = await c.generate("image", BODY, { idempotencyKey: "k-5" }).catch((e) => e);
    expect(fake.calls).toHaveLength(1);
    expect(error.message).toContain(`multix sume status ${JOB_ID}`);
    expect(error.message).toContain("[request req_123]");
  });

  it("rejects an idempotency key Sume would refuse", async () => {
    const { fake, client: c } = client({});
    await expect(c.generate("image", BODY, { idempotencyKey: "bad\nkey" })).rejects.toThrow(
      /printable ASCII/,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("scrubs a key echoed in an error body", async () => {
    const { client: c } = client({
      [GENERATE]: [{ status: 400, text: `bad header Authorization: Bearer ${KEY}` }],
    });
    const error = await c.generate("image", BODY).catch((e) => e);
    expect(String(error.message)).not.toContain(KEY);
    expect(String(error.cause?.snippet ?? "")).not.toContain(KEY);
    expect(error.message).toContain("[redacted]");
  });
});

describe("status, wait, result, job", () => {
  it("maps IN_PROGRESS to processing and refuses a status for another job", async () => {
    const { client: c } = client({
      [STATUS]: [
        { json: { data: { job_id: JOB_ID, status: "IN_PROGRESS", terminal: false } } },
        {
          json: status("queued", {
            job_id: "job_ffffffff-0000-0000-0000-000000000000",
            request_id: undefined,
          }),
        },
      ],
    });
    expect((await c.getStatus(JOB_ID)).status).toBe("processing");
    await expect(c.getStatus(JOB_ID)).rejects.toBeInstanceOf(SumeMalformedResponseError);
  });

  it("refuses an id that is not a job id before any request", async () => {
    const { fake, client: c } = client({});
    await expect(c.getStatus("../v1/open/balance")).rejects.toThrow(/Invalid Sume job id/);
    expect(fake.calls).toHaveLength(0);
  });

  it("polls at Sume's hint (never under 2s), retrying a 503", async () => {
    const sleep = vi.fn(noSleep);
    const { client: c } = client(
      {
        [STATUS]: [
          { json: status("queued", { next_poll_after_seconds: 0.5 }) },
          { status: 503, text: "unavailable" },
          { json: status("processing", { next_poll_after_seconds: 7 }) },
          { json: status("completed") },
        ],
      },
      { sleep },
    );
    const final = await c.waitForJob(JOB_ID, { timeoutMs: 600_000 });
    expect(final.status).toBe("completed");
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2_000, 3_000, 7_000]);
  });

  it("times out with the resume hint", async () => {
    let t = 0;
    const { client: c } = client(
      { [STATUS]: [{ json: status("processing") }] },
      {
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      },
    );
    const error = await c
      .waitForJob(JOB_ID, { timeoutMs: 5_000, resumeHint: "Resume with: multix sume status x" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(PollTimeoutError);
    expect(error.message).toMatch(/last status: processing.*Resume with: multix sume status x/);
  });

  it("reads artifacts and the job error", async () => {
    const { client: c } = client({
      [`GET /v1/jobs/${JOB_ID}/result`]: [
        { json: { data: { result: { artifacts: [{ url: "http://insecure.test/a.png" }] } } } },
        { status: 409, json: sumeError("job_not_completed", "poll first") },
      ],
      [`GET /v1/jobs/${JOB_ID}`]: [
        {
          json: {
            data: {
              job: {
                id: JOB_ID,
                status: "failed",
                error: {
                  code: "content_policy_rejected",
                  message: "refused\u001b[31m",
                  public_reason: "content_policy_rejected",
                },
              },
            },
          },
        },
      ],
    });
    await expect(c.getResult(JOB_ID)).rejects.toThrow(/artifact without an https URL/);
    await expect(c.getResult(JOB_ID)).rejects.toThrow(/409 job_not_completed/);
    const job = await c.getJob(JOB_ID);
    expect(job.status).toBe("failed");
    expect(job.error).toEqual({
      code: "content_policy_rejected",
      message: "refused[31m",
      publicReason: "content_policy_rejected",
    });
  });
});

describe("cancel", () => {
  const CANCEL = `POST /v1/jobs/${JOB_ID}/cancel`;

  it("reports a cancel and an already canceled job", async () => {
    const { client: c } = client({
      [CANCEL]: [
        {
          json: {
            data: { job_id: JOB_ID, status: "CANCELED", canceled: true, idempotency_hit: false },
          },
        },
        {
          json: {
            data: { job_id: JOB_ID, status: "CANCELED", canceled: true, idempotency_hit: true },
          },
        },
      ],
    });
    expect(await c.cancel(JOB_ID)).toEqual({
      jobId: JOB_ID,
      status: "canceled",
      canceled: true,
      alreadyCanceled: false,
    });
    expect((await c.cancel(JOB_ID)).alreadyCanceled).toBe(true);
  });

  it.each(["job_generation_already_started", "job_not_cancelable"])("maps 409 %s", async (code) => {
    const { client: c } = client({ [CANCEL]: [{ status: 409, json: sumeError(code, "no") }] });
    const error = await c.cancel(JOB_ID).catch((e) => e);
    expect(error).toBeInstanceOf(SumeApiError);
    expect(error.sumeCode).toBe(code);
  });
});

describe("catalog", () => {
  it("URL-encodes a model id with a slash", async () => {
    const { fake, client: c } = client({
      "GET /v1/open/catalog/sumelabs%2Fwand": [
        { json: { data: { id: "sumelabs/wand", kind: "video", modes: [] } } },
      ],
    });
    expect((await c.getModel("sumelabs/wand")).id).toBe("sumelabs/wand");
    expect(fake.calls[0]?.headers.authorization).toBeUndefined();
  });

  it("strips control characters, skips bad rows and dedupes ids", () => {
    const parsed = parseCatalog(
      catalogBody([
        {
          id: "a",
          kind: "image",
          name: "Evil\u001b]8;;https://x\u0007name",
          modes: ["text\u0000-to-image"],
        },
        { id: "a", kind: "video" },
        { id: "../etc", kind: "image" },
        { kind: "image" },
        "junk",
      ]),
    );
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0]).toMatchObject({
      id: "a",
      kind: "image",
      name: "Evil]8;;https://xname",
      modes: ["text-to-image"],
    });
  });

  it("throws on a body without a models list", async () => {
    expect(() => parseCatalog({ data: {} })).toThrow(/no models list/);
    const { client: c } = client({ "GET /v1/open/catalog": [{ json: { error: "nope" } }] });
    await expect(c.catalog()).rejects.toBeInstanceOf(SumeMalformedResponseError);
  });
});

describe("uploadFile", () => {
  const TICKET = "POST /v1/files/generate-upload-url";
  const data = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });

  function ticket(extra: Record<string, unknown> = {}) {
    return {
      json: {
        data: {
          upload_url: UPLOAD_URL,
          public_url: PUBLIC_URL,
          upload_method: "PUT",
          upload_headers: { "Content-Type": "image/png", "Content-Length": "4" },
          ...extra,
        },
      },
    };
  }

  it("PUTs the bytes with exactly the returned headers and no key", async () => {
    const { fake, client: c } = client({
      [TICKET]: [ticket()],
      [`PUT ${UPLOAD_URL}`]: [{ status: 200, text: "" }],
    });
    expect(await c.uploadFile({ data, contentType: "image/png", filename: "cat.png" })).toBe(
      PUBLIC_URL,
    );
    const [ask, put] = fake.calls;
    expect(ask?.body).toEqual({ content_type: "image/png", size_bytes: 4, filename: "cat.png" });
    expect(put?.headers).toEqual({ "content-type": "image/png" });
    expect(put?.rawBody).toBe(data);
  });

  it.each([
    ["a private upload host", { upload_url: "https://127.0.0.1/put" }, /local or private address/],
    ["a non-https upload URL", { upload_url: "http://uploads.sume.test/put" }, /only https/],
    [
      "a private public URL",
      { public_url: "https://169.254.169.254/latest" },
      /local or private address/,
    ],
    [
      "an authorization header",
      { upload_headers: { Authorization: "Bearer x" } },
      /authorization header/,
    ],
    ["another file size", { upload_headers: { "Content-Length": "999" } }, /different file size/],
  ])("refuses %s before sending the file", async (_name, extra, message) => {
    const { fake, client: c } = client({ [TICKET]: [ticket(extra)] });
    await expect(c.uploadFile({ data, contentType: "image/png" })).rejects.toThrow(message);
    expect(fake.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("maps a failed PUT without printing the signed URL", async () => {
    const { client: c } = client({
      [TICKET]: [ticket()],
      [`PUT ${UPLOAD_URL}`]: [{ status: 403, text: "SignatureDoesNotMatch" }],
    });
    const error = await c.uploadFile({ data, contentType: "image/png" }).catch((e) => e);
    expect(error.message).toMatch(/403/);
    expect(error.message).not.toContain("UPLOAD_SIGNATURE_456");
  });
});
