/**
 * TopView API Platform client against the in-memory fake: auth (no Topview-Uid),
 * route allowlist and body-family checks before any request, Idempotency-Key
 * reuse across retries (Retry-After honoured), the orphan hint, error mapping,
 * payment_required as terminal, and the public catalog. No network.
 */

import { describe, expect, it } from "vitest";
import {
  TopviewApiError,
  TopviewPredictionError,
} from "../../../../src/providers/topview/errors.js";
import {
  PLATFORM_ROUTES,
  assertBodyFamily,
  assertPlatformRoute,
} from "../../../../src/providers/topview/models.js";
import {
  TopviewPlatformClient,
  fetchPlatformCatalog,
} from "../../../../src/providers/topview/platform-client.js";
import {
  PLATFORM_BASE,
  PLATFORM_KEY,
  PREDICTION_ID,
  VIDEO_URL,
  createFakeTopview,
  data,
  prediction,
} from "./fake-topview.js";

const ROUTE = "bytedance/seedance-2.0/text-to-video";
const SUBMIT = `POST /api/v1/models/${ROUTE}/predictions`;
const GET = `GET /api/v1/predictions/${PREDICTION_ID}`;
const BODY = { content: [{ type: "text", text: "a secret product prompt" }], ratio: "16:9" };

function client(routes: Parameters<typeof createFakeTopview>[0], sleeps: number[] = []) {
  const fake = createFakeTopview(routes);
  let n = 0;
  const c = new TopviewPlatformClient({
    apiKey: PLATFORM_KEY,
    baseUrl: PLATFORM_BASE,
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    newIdempotencyKey: () => `key-${++n}-0123456789`,
  });
  return { fake, c, sleeps };
}

async function errorOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}

describe("submit", () => {
  it("sends Bearer key, Idempotency-Key and no Topview-Uid", async () => {
    const { fake, c } = client({ [SUBMIT]: [data(prediction("created"))] });
    const res = await c.submit(ROUTE, BODY);
    expect(res).toEqual({
      prediction: expect.objectContaining({ id: PREDICTION_ID, status: "created" }),
      idempotencyKey: "key-1-0123456789",
    });
    const [call] = fake.calls;
    expect(call?.headers.authorization).toBe(`Bearer ${PLATFORM_KEY}`);
    expect(call?.headers["idempotency-key"]).toBe("key-1-0123456789");
    expect(call?.headers["topview-uid"]).toBeUndefined();
    expect(call?.body).toEqual(BODY);
  });

  it("reuses the same key on network/5xx/429 retries and honours Retry-After", async () => {
    const { fake, c, sleeps } = client({
      [SUBMIT]: [
        { throws: new TypeError("fetch failed") },
        { status: 429, json: { message: "busy" }, headers: { "retry-after": "7" } },
        data(prediction("processing")),
      ],
    });
    await c.submit(ROUTE, BODY);
    expect(fake.calls).toHaveLength(3);
    expect(new Set(fake.calls.map((x) => x.headers["idempotency-key"]))).toEqual(
      new Set(["key-1-0123456789"]),
    );
    expect(sleeps[1]).toBe(7000);
  });

  it("gives up after 2 retries with a same-key retry command", async () => {
    const { fake, c } = client({ [SUBMIT]: [{ status: 503, text: "unavailable" }] });
    const e = await errorOf(c.submit(ROUTE, BODY));
    expect(fake.calls).toHaveLength(3);
    expect(e.message).toMatch(
      /may have been created anyway.*multix topview run bytedance\/seedance-2\.0\/text-to-video --input <same input> --idempotency-key key-1-0123456789/,
    );
  });

  it("uses a caller-supplied key and validates it", async () => {
    const { fake, c } = client({ [SUBMIT]: [data(prediction("created"))] });
    await c.submit(ROUTE, BODY, { idempotencyKey: "earlier-key-123" });
    expect(fake.calls[0]?.headers["idempotency-key"]).toBe("earlier-key-123");
    await expect(c.submit(ROUTE, BODY, { idempotencyKey: "bad key\n" })).rejects.toThrow();
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects unverified routes and mismatched bodies before any request", async () => {
    const { fake, c } = client({});
    await expect(c.submit("openai/sora-3/text-to-video", BODY)).rejects.toThrow(
      /Unsupported TopView API Platform route/,
    );
    await expect(c.submit(ROUTE, { prompt: "x" })).rejects.toThrow(/content.*non-empty array/);
    await expect(c.submit("alibaba/wan-3.0/text-to-video", BODY)).rejects.toThrow(
      /"input" must be an object/,
    );
    await expect(c.submit("openai/gpt-image-2/text-to-image", BODY)).rejects.toThrow(
      /"prompt" must be a non-empty string/,
    );
    await expect(c.submit(ROUTE, { ...BODY, model: "x" })).rejects.toThrow(/"model" comes from/);
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    [
      401,
      { error: { code: "UNAUTHENTICATED", message: "bad key" }, requestId: "req_1" },
      /TOPVIEW_PLATFORM_API_KEY \(401 UNAUTHENTICATED: bad key\) \(request req_1\)/,
    ],
    [403, { error: { code: "FORBIDDEN" } }, /models:generate.*requests:read/],
    [402, { error: { code: "INSUFFICIENT_BALANCE" } }, /needs more balance/],
    [400, { error: { code: "INVALID_ARGUMENT", message: "ratio" } }, /rejected the request/],
  ])("maps HTTP %s without retrying", async (status, json, re) => {
    const { fake, c } = client({ [SUBMIT]: [{ status, json }] });
    const e = await errorOf(c.submit(ROUTE, BODY));
    expect(e).toBeInstanceOf(TopviewApiError);
    expect(e.message).toMatch(re);
    expect(e.message).not.toMatch(/may have been created/);
    expect(fake.calls).toHaveLength(1);
  });

  it("treats a non-200 envelope code on HTTP 200 as an error", async () => {
    const { c } = client({
      [SUBMIT]: [{ json: { code: 401, message: "UNAUTHENTICATED" } }],
    });
    await expect(c.submit(ROUTE, BODY)).rejects.toThrow(/TOPVIEW_PLATFORM_API_KEY/);
  });
});

describe("predictions", () => {
  it("validates the id before building a URL", async () => {
    const { fake, c } = client({});
    await expect(c.getPrediction("../models")).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });

  it("polls until completed and keeps the billing fields", async () => {
    const { c, sleeps } = client({
      [GET]: [
        data(prediction("processing", { charged_usd: "0.4", billing_state: "RESERVED" })),
        { status: 502, text: "bad gateway" },
        data(
          prediction("completed", {
            outputs: [VIDEO_URL],
            charged_usd: "0.320000000000",
            billing_state: "CAPTURED",
          }),
        ),
      ],
    });
    const p = await c.waitForPrediction(PREDICTION_ID, { timeoutMs: 600_000 });
    expect(p).toMatchObject({
      status: "completed",
      outputs: [VIDEO_URL],
      charged_usd: "0.320000000000",
      billing_state: "CAPTURED",
    });
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(2000);
  });

  it("stops at payment_required and explains how to top up", async () => {
    const { c } = client({
      [GET]: [
        data(
          prediction("payment_required", {
            code: 402,
            amount_due_usd: "1.2",
            shortfall_usd: "0.5",
          }),
        ),
      ],
    });
    const p = await c.waitForPrediction(PREDICTION_ID, { timeoutMs: 60_000 });
    expect(p.status).toBe("payment_required");
    const e = new TopviewPredictionError(p);
    expect(e.message).toMatch(/Amount due: \$1\.2\. Shortfall: \$0\.5\..*platform\.topview\.ai/);
    expect(e.message).toMatch(/multix topview prediction .* --wait --download/);
  });

  it("keeps an unknown status as not finished", async () => {
    const { c } = client({
      [GET]: [data(prediction("queued")), data(prediction("failed", { error: "nsfw" }))],
    });
    const p = await c.waitForPrediction(PREDICTION_ID, { timeoutMs: 60_000 });
    expect(p).toMatchObject({ status: "failed", error: "nsfw" });
  });
});

describe("catalog and routes", () => {
  it("reads the public catalog without a key", async () => {
    const fake = createFakeTopview({
      "GET /platform/v1/models": [
        {
          json: {
            code: 200,
            data: {
              items: [
                {
                  displayName: "Seedance 2.0",
                  manufacturer: "ByteDance",
                  offers: [
                    {
                      spec: { resolution: "720p" },
                      price: { unit: "second", saleUnitUsd: "0.1", componentCode: "video_seconds" },
                    },
                  ],
                },
              ],
              nextCursor: "abc",
            },
          },
        },
      ],
    });
    const catalog = await fetchPlatformCatalog({ baseUrl: PLATFORM_BASE, fetch: fake.fetch });
    expect(fake.calls[0]?.headers.authorization).toBeUndefined();
    expect(catalog.truncated).toBe(true);
    expect(catalog.models[0]).toMatchObject({
      displayName: "Seedance 2.0",
      offers: [{ spec: { resolution: "720p" }, saleUnitUsd: "0.1", unit: "second" }],
    });
  });

  it("every verified route carries a source URL, verified_at and a known family", () => {
    expect(PLATFORM_ROUTES.length).toBe(22);
    for (const r of PLATFORM_ROUTES) {
      expect(r.route).toMatch(/^[a-z0-9.-]+\/[a-z0-9.-]+\/[a-z-]+$/);
      expect(r.source).toMatch(/^https:\/\//);
      expect(r.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(assertPlatformRoute(r.route)).toBe(r);
    }
  });

  it("accepts each family's documented body shape", () => {
    expect(() =>
      assertBodyFamily(assertPlatformRoute("alibaba/wan-3.0/text-to-video"), {
        input: { prompt: "x" },
        parameters: { resolution: "720P" },
      }),
    ).not.toThrow();
    expect(() =>
      assertBodyFamily(assertPlatformRoute("openai/gpt-image-2/text-to-image"), {
        prompt: "x",
        quality: "high",
      }),
    ).not.toThrow();
  });
});
