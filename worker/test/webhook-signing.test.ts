import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/core/errors.js";
import {
  DEFAULT_SUBSCRIPTION_TTL_SECONDS,
  MAX_SUBSCRIPTION_TTL_SECONDS,
} from "../src/events/event-hub.js";
import { parseSubscriptionInput } from "../src/events/subscription-input.js";
import {
  generateWebhookSecret,
  signWebhook,
  verifyWebhook,
} from "../src/events/webhook-signing.js";

describe("Standard Webhooks signing", () => {
  it("matches the Standard Webhooks reference vector", async () => {
    const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const signature = await signWebhook(
      secret,
      "msg_p5jXN8AQM9LWM0D4loKWxJek",
      1614265330,
      '{"test": 2432232314}',
    );
    expect(signature).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("verifies a fresh delivery and rejects a stale, tampered or foreign one", async () => {
    const secret = generateWebhookSecret();
    const body = '{"id":"evt_1"}';
    const now = 1_800_000_000;
    const headers = {
      id: "evt_1",
      timestamp: String(now),
      signature: await signWebhook(secret, "evt_1", now, body),
    };
    expect(await verifyWebhook(secret, headers, body, now + 10)).toBe(true);
    expect(await verifyWebhook(secret, headers, body, now + 3600)).toBe(false);
    expect(await verifyWebhook(secret, headers, `${body} `, now)).toBe(false);
    expect(await verifyWebhook(generateWebhookSecret(), headers, body, now)).toBe(false);
    expect(await verifyWebhook(secret, { ...headers, id: "evt_2" }, body, now)).toBe(false);
  });

  it("generates distinct 32-byte secrets", () => {
    const a = generateWebhookSecret();
    expect(a).not.toBe(generateWebhookSecret());
    expect(atob(a.slice("whsec_".length))).toHaveLength(32);
  });
});

describe("parseSubscriptionInput", () => {
  const ORIGIN = "https://multix.zuey.me";
  const parse = (raw: Record<string, unknown>) => parseSubscriptionInput(raw, ORIGIN);

  it("accepts a public https callback with defaults", () => {
    expect(parse({ callback_url: "https://hooks.example.com/in" })).toEqual({
      callbackUrl: "https://hooks.example.com/in",
      events: [
        "multix.job.completed",
        "multix.job.failed",
        "multix.job.canceled",
        "multix.job.timed_out",
        "multix.asset.ready",
      ],
      ttlSeconds: DEFAULT_SUBSCRIPTION_TTL_SECONDS,
    });
    expect(
      parse({
        callback_url: "https://hooks.example.com/in",
        events: ["multix.job.failed", "multix.job.failed"],
        ttl_seconds: 7200,
        description: "  ci  ",
      }),
    ).toMatchObject({ events: ["multix.job.failed"], ttlSeconds: 7200, description: "ci" });
  });

  it("rejects callbacks that are not public https host names or point back at the server", () => {
    for (const url of [
      "http://hooks.example.com/in",
      "https://127.0.0.1/in",
      "https://[::1]/in",
      "https://localhost/in",
      "https://metadata.google.internal/x",
      "https://hooks.example.com:8443/in",
      "https://user:pw@hooks.example.com/in",
      "https://multix.zuey.me/api/v1/jobs",
      "https://MULTIX.zuey.me./x",
      `https://example.com/${"a".repeat(3000)}`,
      "not a url",
    ]) {
      expect(() => parse({ callback_url: url }), url).toThrow(ValidationError);
    }
    expect(() => parse({})).toThrow(ValidationError);
  });

  it("rejects unknown events, empty lists and out-of-range lifetimes", () => {
    const base = { callback_url: "https://hooks.example.com/in" };
    for (const raw of [
      { ...base, events: [] },
      { ...base, events: ["multix.job.started"] },
      { ...base, events: "multix.job.failed" },
      { ...base, ttl_seconds: 60 },
      { ...base, ttl_seconds: MAX_SUBSCRIPTION_TTL_SECONDS + 1 },
      { ...base, ttl_seconds: 3600.5 },
      { ...base, description: "x".repeat(201) },
    ]) {
      expect(() => parse(raw), JSON.stringify(raw).slice(0, 80)).toThrow(ValidationError);
    }
  });
});
