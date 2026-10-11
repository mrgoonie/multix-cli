import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HttpError } from "../../../../src/core/errors.js";
import {
  HeygenApiError,
  describeHeygenError,
  parseHeygenErrorBody,
  toHeygenApiError,
} from "../../../../src/providers/heygen/heygen-errors.js";
import { summarizeState } from "../../../../src/providers/heygen/node-helpers.js";
import { verifyHeygenWebhookSignature } from "../../../../src/providers/heygen/webhook.js";

describe("HeyGen error mapping", () => {
  it("parses full and truncated error bodies", () => {
    expect(
      parseHeygenErrorBody('{"error":{"code":"forbidden","message":"No access","param":null}}'),
    ).toMatchObject({ code: "forbidden", message: "No access" });
    expect(parseHeygenErrorBody('{"error":{"code":"invalid_parameter","message":"bad val')).toEqual(
      {
        code: "invalid_parameter",
      },
    );
  });

  it("gives an actionable hint per status", () => {
    expect(describeHeygenError(403, "insufficient_api_key_scope", "scope", undefined)).toMatch(
      /scope/,
    );
    expect(describeHeygenError(403, "forbidden", undefined, undefined)).toMatch(/Enterprise/);
    expect(describeHeygenError(429, "rate_limit_exceeded", "slow", undefined, 5000)).toMatch(
      /Retry after 5s\..*reduce parallel jobs/,
    );
    expect(describeHeygenError(422, "invalid_parameter", "bad", "voice_id")).toMatch(
      /\(param: voice_id\)\. Fix the request/,
    );
    expect(describeHeygenError(0, undefined, "fetch failed", undefined)).toMatch(/Network error/);
  });

  it("converts HttpError into HeygenApiError, preserving retryAfterMs", () => {
    const err = toHeygenApiError(
      new HttpError(
        429,
        '{"error":{"code":"rate_limit_exceeded","message":"Too many"}}',
        "https://api.heygen.com/v3/videos",
        2000,
      ),
    );
    expect(err).toBeInstanceOf(HeygenApiError);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.retryAfterMs).toBe(2000);
    expect(err.apiCode).toBe("rate_limit_exceeded");
  });
});

describe("verifyHeygenWebhookSignature", () => {
  const secret = "whsec_test";
  const body = '{"event_type":"avatar_video.success","event_data":{"video_id":"v1"}}';
  const good = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts the HMAC-SHA256 hex digest of the raw body", async () => {
    expect(await verifyHeygenWebhookSignature(body, good, secret)).toBe(true);
    expect(
      await verifyHeygenWebhookSignature(
        new TextEncoder().encode(body),
        good.toUpperCase(),
        secret,
      ),
    ).toBe(true);
  });

  it("rejects wrong, malformed, or missing signatures", async () => {
    expect(await verifyHeygenWebhookSignature(`${body} `, good, secret)).toBe(false);
    expect(await verifyHeygenWebhookSignature(body, good, "other")).toBe(false);
    expect(await verifyHeygenWebhookSignature(body, "zz", secret)).toBe(false);
    expect(await verifyHeygenWebhookSignature(body, undefined, secret)).toBe(false);
    expect(await verifyHeygenWebhookSignature(body, good, "")).toBe(false);
  });
});

describe("secret redaction in summaries", () => {
  it("drops signed query strings from output URLs", () => {
    const summary = summarizeState({
      kind: "video",
      id: "v1",
      status: "completed",
      done: true,
      succeeded: true,
      outputUrl: "https://files.heygen.test/v1.mp4?Signature=SECRET&Expires=1",
      raw: {},
    });
    const text = JSON.stringify(summary);
    expect(text).toContain("https://files.heygen.test/v1.mp4");
    expect(text).not.toContain("SECRET");
  });
});
