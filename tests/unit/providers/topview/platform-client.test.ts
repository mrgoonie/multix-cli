/**
 * TopView API Platform client against a fake API: the Idempotency-Key and body
 * are reused across submit retries, ambiguous failures carry the key, 402 and
 * other 4xx are never retried, payment_required and failed predictions,
 * validation before any request, media uploads and error mapping. No network
 * or paid calls.
 */

import { describe, expect, it } from "vitest";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import { ValidationError } from "../../../../src/core/errors.js";
import {
  MEDIA_MAX_BYTES,
  TopviewAmbiguousSubmitError,
  TopviewPaymentRequiredError,
  TopviewPlatformClient,
  TopviewPlatformError,
  TopviewPredictionError,
  assertPredictionCompleted,
  isValidIdempotencyKey,
  newIdempotencyKey,
  parsePrediction,
} from "../../../../src/providers/topview/platform-client.js";
import { requirePlatformModel } from "../../../../src/providers/topview/platform-models.js";
import {
  IMAGE_URL,
  PLATFORM_BASE,
  PLATFORM_KEY,
  PREDICTION_ID,
  VIDEO_URL,
  createFakeTopview,
  data,
  prediction,
} from "./fake-topview.js";

const SPEC = requirePlatformModel("topview/topview-t1/text-to-video");
const SUBMIT = `POST ${PLATFORM_BASE}/models/topview/topview-t1/text-to-video/predictions`;
const GET = `GET ${PLATFORM_BASE}/predictions/${PREDICTION_ID}`;
const BODY = { content: [{ type: "text", text: "a cat on a skateboard" }], duration: 5 };
const IDEM = "idem-key-0001";

function client(routes: Parameters<typeof createFakeTopview>[0]) {
  const fake = createFakeTopview(routes);
  const sleeps: number[] = [];
  const c = new TopviewPlatformClient({
    apiKey: PLATFORM_KEY,
    baseUrl: PLATFORM_BASE,
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client: c, calls: fake.calls, sleeps };
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("submit", () => {
  it("posts to the model route with Bearer auth and the Idempotency-Key", async () => {
    const { client: c, calls } = client({ [SUBMIT]: [data(prediction("created"))] });
    const p = await c.submit(SPEC, BODY, IDEM);
    expect(p).toMatchObject({ id: PREDICTION_ID, status: "created", outputs: [] });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${PLATFORM_KEY}`);
    expect(calls[0]?.headers["idempotency-key"]).toBe(IDEM);
    expect(calls[0]?.body).toEqual(BODY);
  });

  it("retries 503 and 429 with the same key and body, honouring Retry-After", async () => {
    const {
      client: c,
      calls,
      sleeps,
    } = client({
      [SUBMIT]: [
        { status: 503, text: "busy" },
        { status: 429, text: "slow down", headers: { "retry-after": "1" } },
        data(prediction("created")),
      ],
    });
    const p = await c.submit(SPEC, BODY, IDEM);
    expect(p.id).toBe(PREDICTION_ID);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((x) => x.headers["idempotency-key"]))).toEqual(new Set([IDEM]));
    for (const call of calls) expect(call.body).toEqual(BODY);
    expect(sleeps).toEqual([2_000, 1_000]);
  });

  it("gives up on an ambiguous failure with the key for a safe retry", async () => {
    const { client: c, calls } = client({ [SUBMIT]: [{ status: 502, text: "bad gateway" }] });
    const error = await caught(c.submit(SPEC, BODY, IDEM, 2));
    expect(error).toBeInstanceOf(TopviewAmbiguousSubmitError);
    expect((error as TopviewAmbiguousSubmitError).idempotencyKey).toBe(IDEM);
    expect(error.message).toContain(IDEM);
    expect(error.message).toContain("may have been created");
    expect(calls).toHaveLength(3);
  });

  it("treats a network error as ambiguous", async () => {
    const { client: c } = client({ [SUBMIT]: [{ throws: new TypeError("fetch failed") }] });
    const error = await caught(c.submit(SPEC, BODY, IDEM, 0));
    expect(error).toBeInstanceOf(TopviewAmbiguousSubmitError);
  });

  it("treats a 2xx without a usable prediction as ambiguous", async () => {
    const { client: c } = client({ [SUBMIT]: [data({ status: "created" })] });
    const error = await caught(c.submit(SPEC, BODY, IDEM, 0));
    expect(error).toBeInstanceOf(TopviewAmbiguousSubmitError);
  });

  it("never retries 402 and points at the top-up page", async () => {
    const { client: c, calls } = client({
      [SUBMIT]: [
        {
          status: 402,
          json: { error: { code: "INSUFFICIENT_BALANCE", message: "balance too low" } },
        },
      ],
    });
    const error = await caught(c.submit(SPEC, BODY, IDEM));
    expect(error).toBeInstanceOf(TopviewPlatformError);
    expect(error).not.toBeInstanceOf(TopviewAmbiguousSubmitError);
    expect((error as TopviewPlatformError).status).toBe(402);
    expect((error as TopviewPlatformError).apiCode).toBe("INSUFFICIENT_BALANCE");
    expect(error.message).toContain("Top up");
    expect(calls).toHaveLength(1);
  });

  it("never retries a 400", async () => {
    const { client: c, calls } = client({
      [SUBMIT]: [{ status: 400, json: { code: "INVALID_REQUEST", message: "bad field" } }],
    });
    const error = await caught(c.submit(SPEC, BODY, IDEM));
    expect(error).toBeInstanceOf(TopviewPlatformError);
    expect(error.message).toContain("[INVALID_REQUEST]: bad field");
    expect(calls).toHaveLength(1);
  });

  it("maps a non-200 envelope code without retrying", async () => {
    const { client: c, calls } = client({
      [SUBMIT]: [{ json: { code: 40001, message: "model unavailable" } }],
    });
    const error = await caught(c.submit(SPEC, BODY, IDEM));
    expect(error).toBeInstanceOf(TopviewPlatformError);
    expect(error.message).toContain("code 40001");
    expect(calls).toHaveLength(1);
  });

  it("validates the body and the key before sending anything", async () => {
    const { client: c, calls } = client({ [SUBMIT]: [data(prediction("created"))] });
    await expect(c.submit(SPEC, { ...BODY, colour: "red" }, IDEM)).rejects.toThrow(ValidationError);
    await expect(c.submit(SPEC, { ...BODY, duration: 99 }, IDEM)).rejects.toThrow(/4-30 seconds/);
    await expect(c.submit(SPEC, BODY, "bad key!")).rejects.toThrow(/Idempotency key/);
    expect(calls).toHaveLength(0);
  });

  it("scrubs the key from an error body that echoes it", async () => {
    const { client: c } = client({
      [SUBMIT]: [{ status: 400, text: `rejected Bearer ${PLATFORM_KEY}` }],
    });
    const error = await caught(c.submit(SPEC, BODY, IDEM));
    expect(error.message).not.toContain(PLATFORM_KEY);
  });
});

describe("idempotency keys", () => {
  it("generates valid, distinct keys and rejects header-unsafe ones", () => {
    const a = newIdempotencyKey();
    expect(isValidIdempotencyKey(a)).toBe(true);
    expect(newIdempotencyKey()).not.toBe(a);
    expect(isValidIdempotencyKey("short")).toBe(false);
    expect(isValidIdempotencyKey("has space 123")).toBe(false);
    expect(isValidIdempotencyKey("line\nbreak123")).toBe(false);
  });
});

describe("predictions", () => {
  it("parses a completed prediction leniently, keeping USD as exact strings", () => {
    const p = parsePrediction(
      prediction("Completed", {
        outputs: [VIDEO_URL, "not-a-url", 42],
        charged_usd: "0.8245",
        billing_state: "settled",
      }),
    );
    expect(p).toMatchObject({
      id: PREDICTION_ID,
      status: "completed",
      outputs: [VIDEO_URL],
      chargedUsd: "0.8245",
      billingState: "settled",
    });
  });

  it("requires an id and a status", () => {
    expect(() => parsePrediction({ status: "created" })).toThrow(/invalid id/);
    expect(() => parsePrediction({ id: PREDICTION_ID })).toThrow(/missing status/);
  });

  it("raises payment_required with the amount due and the top-up hint", () => {
    const p = parsePrediction(
      prediction("payment_required", { amount_due_usd: "0.5", shortfall_usd: 0.25 }),
    );
    const error = (() => {
      try {
        assertPredictionCompleted(p);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(TopviewPaymentRequiredError);
    expect(error?.message).toContain("amount due $0.5");
    expect(error?.message).toContain("shortfall $0.25");
    expect(error?.message).toContain("without resubmitting");
  });

  it("raises failed with the provider's error message", () => {
    const p = parsePrediction(prediction("failed", { error: { message: "content flagged" } }));
    expect(() => assertPredictionCompleted(p)).toThrow(TopviewPredictionError);
    expect(() => assertPredictionCompleted(p)).toThrow(/failed: content flagged/);
  });

  it("waits through 5xx to completed", async () => {
    const { client: c, calls } = client({
      [GET]: [
        data(prediction("created")),
        { status: 500, text: "oops" },
        data(prediction("processing")),
        data(prediction("completed", { outputs: [VIDEO_URL], charged_usd: "0.8245" })),
      ],
    });
    const p = await c.waitForPrediction(PREDICTION_ID, { timeoutMs: 60_000 });
    expect(p.status).toBe("completed");
    expect(p.chargedUsd).toBe("0.8245");
    expect(calls).toHaveLength(4);
  });

  it("stops waiting at payment_required and failed", async () => {
    for (const status of ["payment_required", "failed"]) {
      const { client: c } = client({ [GET]: [data(prediction(status))] });
      const p = await c.waitForPrediction(PREDICTION_ID, { timeoutMs: 60_000 });
      expect(p.status).toBe(status);
    }
  });

  it("times out with the resume hint", async () => {
    const now = steppingClock(100);
    const { client: c } = client({ [GET]: [data(prediction("processing"))] });
    const error = await caught(
      c.waitForPrediction(PREDICTION_ID, {
        timeoutMs: 10,
        resumeHint: "do not resubmit",
        now,
      }),
    );
    expect(error).toBeInstanceOf(PollTimeoutError);
    expect(error.message).toContain("do not resubmit");
  });

  it("maps 401 INVALID_API_KEY to the platform key hint", async () => {
    const { client: c } = client({
      [GET]: [{ status: 401, json: { error: { code: "INVALID_API_KEY", message: "bad key" } } }],
    });
    const error = await caught(c.getPrediction(PREDICTION_ID));
    expect(error).toBeInstanceOf(TopviewPlatformError);
    expect((error as TopviewPlatformError).apiCode).toBe("INVALID_API_KEY");
    expect(error.message).toContain("TOPVIEW_PLATFORM_API_KEY");
  });

  it("explains a 404 from a rotated key", async () => {
    const { client: c } = client({ [GET]: [{ status: 404, text: "" }] });
    await expect(c.getPrediction(PREDICTION_ID)).rejects.toThrow(/another key/);
  });

  it("rejects an unsafe prediction id before any request", async () => {
    const { client: c, calls } = client({});
    await expect(c.getPrediction("../x")).rejects.toThrow(/Invalid TopView prediction id/);
    expect(calls).toHaveLength(0);
  });
});

describe("uploadMedia", () => {
  const MEDIA = `POST ${PLATFORM_BASE}/media/files`;

  it("posts multipart form data and returns the signed download URL", async () => {
    const { client: c, calls } = client({
      [MEDIA]: [data({ id: "media_1", download_url: IMAGE_URL, reference: "ref_1" })],
    });
    const asset = await c.uploadMedia({
      data: new Blob([new Uint8Array([1, 2])], { type: "image/png" }),
      filename: "a.png",
      kind: "image",
    });
    expect(asset).toEqual({ id: "media_1", downloadUrl: IMAGE_URL, reference: "ref_1" });
    const form = calls[0]?.rawBody as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("kind")).toBe("image");
    expect((form.get("file") as File).name).toBe("a.png");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${PLATFORM_KEY}`);
    expect(calls[0]?.redirect).toBe("manual");
  });

  it("refuses files over 20 MiB before sending", async () => {
    const { client: c, calls } = client({});
    await expect(
      c.uploadMedia({
        data: new Blob([new Uint8Array(MEDIA_MAX_BYTES + 1)]),
        filename: "big.png",
        kind: "image",
      }),
    ).rejects.toThrow(/20 MiB/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a private download URL", async () => {
    const { client: c } = client({
      [MEDIA]: [data({ id: "media_1", download_url: "https://192.168.1.10/a.png" })],
    });
    await expect(
      c.uploadMedia({ data: new Blob(["x"]), filename: "a.png", kind: "image" }),
    ).rejects.toThrow();
  });

  it("maps an upload error without leaking the key", async () => {
    const { client: c } = client({
      [MEDIA]: [{ status: 413, text: `too big for ${PLATFORM_KEY}` }],
    });
    const error = await caught(
      c.uploadMedia({ data: new Blob(["x"]), filename: "a.png", kind: "image" }),
    );
    expect((error as TopviewPlatformError).status).toBe(413);
    expect(error.message).not.toContain(PLATFORM_KEY);
  });
});

/** A clock that advances `step` ms on every read, so a deadline passes without sleeping. */
function steppingClock(step: number): () => number {
  let t = 0;
  return () => {
    t += step;
    return t;
  };
}
