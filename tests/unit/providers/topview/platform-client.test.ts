import { describe, expect, it } from "vitest";
import { classifyError } from "../../../../src/core/error-classify.js";
import { findPlatformRoute } from "../../../../src/providers/topview/models.js";
import {
  TopviewPlatformFailedError,
  assertValidIdempotencyKey,
} from "../../../../src/providers/topview/platform-client.js";
import {
  PLATFORM_BASE,
  PLATFORM_KEY,
  createFakeTopview,
  noSleep,
  platformError,
  prediction,
} from "./fake-topview.js";

const ROUTE_ID = "bytedance/seedance-2.0-mini/text-to-video";
const SUBMIT = `POST /api/v1/models/${ROUTE_ID}/predictions`;
const POLL = "GET /api/v1/predictions/pred_1";
const KEY = "idem-key-0001";

function route() {
  const r = findPlatformRoute(ROUTE_ID);
  if (!r) throw new Error(`route ${ROUTE_ID} is not in the verified list`);
  return r;
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    return { code: classifyError(e).code, message: e instanceof Error ? e.message : String(e) };
  }
  throw new Error("expected a rejection");
}

describe("TopviewPlatformClient createPrediction", () => {
  it("sends Bearer and Idempotency-Key and returns the prediction", async () => {
    const { platform, calls } = createFakeTopview({
      [SUBMIT]: { body: prediction("pred_1", "created", { billing_state: "RESERVED" }) },
    });
    const p = await platform.createPrediction(route(), { prompt: "waves" }, KEY);
    expect(p.id).toBe("pred_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${PLATFORM_BASE}/api/v1/models/${ROUTE_ID}/predictions`);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${PLATFORM_KEY}`);
    expect(calls[0]?.headers["idempotency-key"]).toBe(KEY);
    expect(calls[0]?.body).toEqual({ prompt: "waves" });
  });

  it("401 is a wrong key and 402 an empty balance", async () => {
    const wrong = createFakeTopview({
      [SUBMIT]: { status: 401, body: platformError("unauthorized", "Invalid API key") },
    });
    expect((await failure(wrong.platform.createPrediction(route(), {}, KEY))).code).toBe(
      "INVALID_KEY",
    );
    const broke = createFakeTopview({
      [SUBMIT]: { status: 402, body: platformError("insufficient_balance", "Top up") },
    });
    expect((await failure(broke.platform.createPrediction(route(), {}, KEY))).code).toBe(
      "QUOTA_EXCEEDED",
    );
  });

  it("a 422 schema rejection is a definite refusal", async () => {
    const { platform } = createFakeTopview({
      [SUBMIT]: { status: 422, body: platformError("validation_error", "prompt is required") },
    });
    const f = await failure(platform.createPrediction(route(), {}, KEY));
    expect(f.code).not.toBe("UNKNOWN_REMOTE_STATE");
    expect(f.message).toContain("prompt is required");
  });

  it("a 429 on submit is reported, not retried", async () => {
    const { platform, calls } = createFakeTopview({
      [SUBMIT]: {
        status: 429,
        body: platformError("rate_limited", "Too many requests", true),
        headers: { "retry-after": "5" },
      },
    });
    expect((await failure(platform.createPrediction(route(), {}, KEY))).code).toBe("RATE_LIMITED");
    expect(calls).toHaveLength(1);
  });

  it("a timeout or reset is unknown and names the idempotency key to reuse", async () => {
    for (const fail of ["timeout", "ECONNRESET"] as const) {
      const { platform, calls } = createFakeTopview({ [SUBMIT]: { fail } });
      const f = await failure(platform.createPrediction(route(), {}, KEY));
      expect(f.code).toBe("UNKNOWN_REMOTE_STATE");
      expect(f.message).toContain(`--idempotency-key ${KEY}`);
      expect(f.message).not.toContain(PLATFORM_KEY);
      expect(calls).toHaveLength(1);
    }
  });

  it("a 500, even with an error body, is unknown", async () => {
    const { platform } = createFakeTopview({
      [SUBMIT]: { status: 500, body: platformError("internal", "boom", true) },
    });
    expect((await failure(platform.createPrediction(route(), {}, KEY))).code).toBe(
      "UNKNOWN_REMOTE_STATE",
    );
  });

  it("a 2xx without a task id is unknown", async () => {
    const { platform } = createFakeTopview({ [SUBMIT]: { body: { code: 0, data: {} } } });
    expect((await failure(platform.createPrediction(route(), {}, KEY))).code).toBe(
      "UNKNOWN_REMOTE_STATE",
    );
  });

  it("refuses a malformed idempotency key before sending", () => {
    expect(() => assertValidIdempotencyKey("short")).toThrow(/idempotency-key/);
    expect(() => assertValidIdempotencyKey("has spaces in it")).toThrow();
    expect(() => assertValidIdempotencyKey("0b7e5c1a-2d3f-4a5b-8c9d-0e1f2a3b4c5d")).not.toThrow();
  });
});

describe("TopviewPlatformClient polling", () => {
  it("waits through payment_required and 429 until completed", async () => {
    const { platform, calls } = createFakeTopview({
      [POLL]: [
        { body: prediction("pred_1", "processing", { billing_state: "RESERVED" }) },
        {
          status: 429,
          body: platformError("rate_limited", "slow"),
          headers: { "retry-after": "2" },
        },
        { body: prediction("pred_1", "payment_required", { shortfall_usd: "0.10" }) },
        {
          body: prediction("pred_1", "completed", {
            outputs: ["https://cdn.topview.test/o/1.mp4"],
            charged_usd: "0.42",
            billing_state: "CAPTURED",
          }),
        },
      ],
    });
    const seen: string[] = [];
    const p = await platform.waitForPrediction("pred_1", {
      timeoutMs: 600_000,
      sleep: noSleep,
      onPoll: (s) => seen.push(s.status),
    });
    expect(p.status).toBe("completed");
    expect(p.charged_usd).toBe("0.42");
    expect(seen).toEqual(["processing", "payment_required", "completed"]);
    expect(calls).toHaveLength(4);
    expect(calls[0]?.headers["idempotency-key"]).toBeUndefined();
  });

  it("a response without data.id/status is a schema mismatch", async () => {
    const { platform } = createFakeTopview({ [POLL]: { body: { code: 0, data: { state: "x" } } } });
    await expect(platform.getPrediction("pred_1")).rejects.toThrow(/schema mismatch/);
  });

  it("a failed task carries the provider's error", async () => {
    const { platform } = createFakeTopview({
      [POLL]: { body: prediction("pred_1", "failed", { error: "content rejected" }) },
    });
    const p = await platform.waitForPrediction("pred_1", { timeoutMs: 60_000, sleep: noSleep });
    const err = new TopviewPlatformFailedError(p);
    expect(err.message).toContain("content rejected");
  });
});

describe("TopviewPlatformClient uploadAsset", () => {
  it("posts multipart once and returns the asset", async () => {
    const { platform, calls } = createFakeTopview({
      "POST /api/v1/media/files": {
        body: { code: 0, data: { id: "asset_1", kind: "image", reference: "asset://asset_1" } },
      },
    });
    const asset = await platform.uploadAsset(new Blob(["png"]), "a.png", "image");
    expect(asset.id).toBe("asset_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBeInstanceOf(FormData);
  });

  it("refuses a file over 20 MiB without sending", async () => {
    const { platform, calls } = createFakeTopview({});
    const big = new Blob([new Uint8Array(20 * 1024 * 1024 + 1)]);
    await expect(platform.uploadAsset(big, "big.mp4", "video")).rejects.toThrow(/20 MiB/);
    expect(calls).toHaveLength(0);
  });
});
