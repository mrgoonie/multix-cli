import { describe, expect, it } from "vitest";
import type { MultixEvent } from "../src/events/event-catalog.js";
import {
  DELIVERY_BATCH,
  DISABLE_AFTER_DEAD_LETTERS,
  EventHub,
  HOUSEKEEPING_INTERVAL_MS,
  MAX_ACTIVE_SUBSCRIPTIONS,
  MAX_DELIVERY_ATTEMPTS,
  RETRY_DELAYS_SECONDS,
  SEEN_RETENTION_MS,
  type SubscriptionInput,
} from "../src/events/event-hub.js";
import { jobEvents } from "../src/events/job-events.js";
import { verifyWebhook } from "../src/events/webhook-signing.js";
import { fakeDoStorage } from "./fake-do-storage.js";

const JOB_ID = "00000000-0000-4000-8000-000000000001";
const T0 = Date.UTC(2026, 9, 15, 10, 0, 0);

function event(status: "succeeded" | "failed" = "succeeded", jobId = JOB_ID): MultixEvent {
  const [first] = jobEvents(
    { jobId, command: "gemini generate" },
    { status, createdAt: T0 - 60_000, finishedAt: T0 },
  );
  if (!first) throw new Error("no event");
  return first;
}

const INPUT: SubscriptionInput = {
  callbackUrl: "https://hooks.example.com/multix?token=abc",
  events: ["multix.job.completed", "multix.job.failed"],
  ttlSeconds: 24 * 60 * 60,
};

interface Sent {
  url: string;
  init: RequestInit;
  body: string;
  headers: Headers;
}

function harness(respond: (sent: Sent) => Response | Promise<Response> = () => new Response("ok")) {
  const fake = fakeDoStorage();
  const sent: Sent[] = [];
  const clock = { t: T0 };
  const ports = {
    storage: fake.storage,
    now: () => clock.t,
    fetch: async (url: string, init: RequestInit) => {
      const entry = {
        url,
        init,
        body: String(init.body),
        headers: new Headers(init.headers as Record<string, string>),
      };
      sent.push(entry);
      return respond(entry);
    },
  };
  const hub = new EventHub(ports);
  /** Run the alarm when it is due, as the runtime would. */
  const runAlarm = async () => {
    const at = fake.alarm();
    if (at === null) return false;
    if (at > clock.t) clock.t = at;
    fake.clearAlarm();
    await hub.alarm();
    return true;
  };
  return { hub, fake, sent, clock, ports, runAlarm };
}

async function subscribe(hub: EventHub, input: SubscriptionInput = INPUT) {
  const result = await hub.subscribe(input, "api_key:k1");
  if (!result.ok) throw new Error(result.message);
  return result;
}

describe("EventHub subscriptions", () => {
  it("returns the secret once and never lists it; the callback query is redacted", async () => {
    const { hub } = harness();
    const { subscription, secret } = await subscribe(hub);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/);
    expect(subscription.callback_url).toBe("https://hooks.example.com/multix?[redacted]");
    const listed = await hub.listSubscriptions();
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(JSON.stringify(listed)).not.toContain("token=abc");
    expect(await hub.getSubscription(subscription.id)).toEqual(subscription);
    expect(await hub.getSubscription("sub_unknown")).toBeNull();
  });

  it("caps active subscriptions per account", async () => {
    const { hub } = harness();
    for (let i = 0; i < MAX_ACTIVE_SUBSCRIPTIONS; i++) await subscribe(hub);
    const result = await hub.subscribe(INPUT, "api_key:k1");
    expect(result).toMatchObject({ ok: false, error: "limit_reached" });
  });

  it("revokes a subscription with its queued deliveries and audits it", async () => {
    const { hub, fake, sent, runAlarm } = harness();
    const { subscription } = await subscribe(hub);
    await hub.publish([event()]);
    expect(await hub.unsubscribe(subscription.id, "api_key:k1")).toBe(true);
    expect(await hub.unsubscribe(subscription.id, "api_key:k1")).toBe(false);
    expect([...fake.data.keys()].some((k) => k.startsWith("q:"))).toBe(false);
    await runAlarm();
    expect(sent).toHaveLength(0);
    const audit = await hub.auditLog();
    expect(audit.map((a) => a.action)).toEqual(["subscription.revoked", "subscription.created"]);
    expect(audit[0]).toMatchObject({ actor: "api_key:k1", detail: "1 queued deliveries dropped" });
  });
});

describe("EventHub publishing", () => {
  it("keeps nothing for an event no subscription wants", async () => {
    const { hub, fake } = harness();
    expect(await hub.publish([event()])).toEqual({ accepted: 1, duplicates: 0 });
    expect(fake.data.size).toBe(0);
    expect(fake.alarm()).toBeNull();
  });

  it("schedules housekeeping when only dead letters were written", async () => {
    const { hub, fake, clock } = harness();
    await subscribe(hub);
    const huge = {
      ...event(),
      data: { ...event().data, command: "é".repeat(9000) },
    } as MultixEvent;
    await hub.publish([huge]);
    expect((await hub.deadLetters())[0]).toMatchObject({ reason: "event too large" });
    expect(fake.alarm()).toBe(clock.t + HOUSEKEEPING_INTERVAL_MS);
  });

  it("revokes a subscription with more queued deliveries than one storage call takes", async () => {
    const { hub, fake } = harness(() => new Response("down", { status: 503 }));
    const { subscription } = await subscribe(hub);
    await hub.publish(
      Array.from({ length: 300 }, (_, i) =>
        event("succeeded", `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
      ),
    );
    expect(await hub.unsubscribe(subscription.id, "api_key:k1")).toBe(true);
    expect([...fake.data.keys()].some((k) => k.startsWith("q:") || k.startsWith("sub:"))).toBe(
      false,
    );
    expect((await hub.auditLog())[0]).toMatchObject({ detail: "300 queued deliveries dropped" });
  });
});

describe("EventHub delivery", () => {
  it("delivers a signed event that the receiver can verify, without following redirects", async () => {
    const { hub, sent, runAlarm, clock } = harness();
    const { secret, subscription } = await subscribe(hub);
    const evt = event();
    expect(await hub.publish([evt])).toEqual({ accepted: 1, duplicates: 0 });
    await runAlarm();
    expect(sent).toHaveLength(1);
    const [delivery] = sent;
    if (!delivery) throw new Error("not sent");
    expect(delivery.url).toBe(INPUT.callbackUrl);
    expect(delivery.init.redirect).toBe("manual");
    expect(delivery.headers.get("webhook-id")).toBe(evt.id);
    expect(JSON.parse(delivery.body)).toEqual(evt);
    const verified = await verifyWebhook(
      secret,
      {
        id: delivery.headers.get("webhook-id") ?? "",
        timestamp: delivery.headers.get("webhook-timestamp") ?? "",
        signature: delivery.headers.get("webhook-signature") ?? "",
      },
      delivery.body,
      Math.floor(clock.t / 1000),
    );
    expect(verified).toBe(true);
    expect(await hub.getSubscription(subscription.id)).toMatchObject({ delivered_count: 1 });
  });

  it("publishes an event once even when it is relayed again or after a restart", async () => {
    const { hub, sent, runAlarm, ports } = harness();
    await subscribe(hub);
    const evt = event();
    await hub.publish([evt]);
    expect(await hub.publish([evt])).toEqual({ accepted: 0, duplicates: 1 });
    // A new object instance over the same storage (Durable Object restart).
    const restarted = new EventHub(ports);
    expect(await restarted.publish([evt])).toEqual({ accepted: 0, duplicates: 1 });
    await runAlarm();
    expect(sent).toHaveLength(1);
  });

  it("delivers only the event names a subscription asked for", async () => {
    const { hub, sent, runAlarm } = harness();
    await subscribe(hub, { ...INPUT, events: ["multix.asset.ready"] });
    await hub.publish([event("failed")]);
    await runAlarm();
    expect(sent).toHaveLength(0);
  });

  it("retries 429 and 5xx with backoff and Retry-After, then succeeds", async () => {
    const statuses = [
      new Response("slow down", { status: 429, headers: { "retry-after": "300" } }),
      new Response("oops", { status: 503 }),
      new Response("ok"),
    ];
    const { hub, sent, runAlarm, fake, clock } = harness(() => statuses.shift() ?? new Response());
    const { subscription } = await subscribe(hub);
    await hub.publish([event()]);
    await runAlarm();
    // First retry waits for Retry-After (300 s) rather than the 30 s backoff.
    expect(fake.alarm()).toBe(clock.t + 300_000);
    await runAlarm();
    expect(fake.alarm()).toBe(clock.t + (RETRY_DELAYS_SECONDS[1] ?? 0) * 1000);
    await runAlarm();
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((s) => s.headers.get("webhook-id"))).size).toBe(1);
    const view = await hub.getSubscription(subscription.id);
    expect(view).toMatchObject({ delivered_count: 1, consecutive_dead_letters: 0 });
    expect(await hub.deadLetters()).toEqual([]);
  });

  it("treats network errors and timeouts as retryable", async () => {
    let calls = 0;
    const { hub, sent, runAlarm } = harness(() => {
      calls++;
      if (calls === 1) throw new TypeError("network");
      if (calls === 2) throw new DOMException("timed out", "TimeoutError");
      return new Response("ok");
    });
    await subscribe(hub);
    await hub.publish([event()]);
    while (await runAlarm()) {
      if (sent.length >= 3) break;
    }
    expect(sent).toHaveLength(3);
    expect(await hub.deadLetters()).toEqual([]);
  });

  it("dead-letters after the last attempt, keeping ids but no payload", async () => {
    const { hub, sent, runAlarm } = harness(() => new Response("down", { status: 500 }));
    const { subscription } = await subscribe(hub);
    await hub.publish([event()]);
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) await runAlarm();
    expect(sent).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    const [dead] = await hub.deadLetters();
    expect(dead).toMatchObject({
      subscriptionId: subscription.id,
      eventId: event().id,
      eventName: "multix.job.completed",
      attempts: MAX_DELIVERY_ATTEMPTS,
      lastStatus: 500,
    });
    expect(JSON.stringify(dead)).not.toContain("gemini");
    expect(await hub.getSubscription(subscription.id)).toMatchObject({
      status: "active",
      consecutive_dead_letters: 1,
    });
  });

  it("does not retry other 4xx answers or redirects", async () => {
    const answers = [
      new Response("bad", { status: 400 }),
      new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } }),
    ];
    const { hub, sent, runAlarm } = harness(() => answers.shift() ?? new Response());
    await subscribe(hub);
    await hub.publish([
      event("succeeded", JOB_ID),
      event("succeeded", "00000000-0000-4000-8000-000000000002"),
    ]);
    await runAlarm();
    expect(sent).toHaveLength(2);
    const dead = await hub.deadLetters();
    expect(dead.map((d) => d.reason).sort()).toEqual([
      "endpoint answered 400",
      "endpoint redirected; redirects are not followed",
    ]);
    expect(await runAlarm()).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("disables a subscription after repeated dead letters and drops its queued deliveries", async () => {
    const { hub, runAlarm } = harness(() => new Response("bad", { status: 400 }));
    const { subscription } = await subscribe(hub);
    const events = Array.from({ length: DISABLE_AFTER_DEAD_LETTERS + 2 }, (_, i) =>
      event("succeeded", `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
    );
    await hub.publish(events);
    await runAlarm();
    const view = await hub.getSubscription(subscription.id);
    expect(view).toMatchObject({ status: "disabled" });
    expect(view?.status_reason).toContain(`${DISABLE_AFTER_DEAD_LETTERS} deliveries in a row`);
    const dead = await hub.deadLetters();
    expect(dead.filter((d) => d.reason === "subscription disabled")).toHaveLength(2);
    expect((await hub.auditLog()).map((a) => a.action)).toContain("subscription.disabled");
    // A disabled subscription receives nothing new.
    await hub.publish([event("failed", "00000000-0000-4000-8000-00000000ffff")]);
    expect((await hub.listSubscriptions())[0]?.status).toBe("disabled");
  });

  it("disables a subscription at once when the endpoint answers 410 Gone", async () => {
    const { hub, runAlarm } = harness(() => new Response(null, { status: 410 }));
    const { subscription } = await subscribe(hub);
    await hub.publish([event()]);
    await runAlarm();
    expect(await hub.getSubscription(subscription.id)).toMatchObject({
      status: "disabled",
      status_reason: "the endpoint answered 410 Gone",
    });
  });

  it("does not bring back a subscription revoked while a delivery was in flight", async () => {
    let revoke: () => Promise<unknown> = async () => undefined;
    const { hub, runAlarm, fake } = harness(async () => {
      await revoke();
      return new Response("ok");
    });
    const { subscription } = await subscribe(hub);
    revoke = () => hub.unsubscribe(subscription.id, "api_key:k1");
    await hub.publish([event()]);
    await runAlarm();
    expect(fake.data.has(`sub:${subscription.id}`)).toBe(false);
  });

  it("keeps no retry or dead letter for a subscription revoked while its delivery failed", async () => {
    for (const status of [503, 400]) {
      let revoke: () => Promise<unknown> = async () => undefined;
      const { hub, runAlarm, fake } = harness(async () => {
        await revoke();
        return new Response("no", { status });
      });
      const { subscription } = await subscribe(hub);
      revoke = () => hub.unsubscribe(subscription.id, "api_key:k1");
      await hub.publish([event()]);
      await runAlarm();
      const keys = [...fake.data.keys()];
      expect(
        keys.filter((k) => k.startsWith("q:") || k.startsWith("dead:")),
        String(status),
      ).toEqual([]);
    }
  });

  it("sends a bounded batch per alarm and continues right away", async () => {
    const { hub, sent, fake, clock } = harness();
    await subscribe(hub);
    const events = Array.from({ length: DELIVERY_BATCH + 3 }, (_, i) =>
      event("succeeded", `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
    );
    await hub.publish(events);
    await hub.alarm();
    expect(sent).toHaveLength(DELIVERY_BATCH);
    expect(fake.alarm()).toBe(clock.t);
    // A backlog does not hold housekeeping back.
    expect(fake.data.get("meta:housekept")).toBe(clock.t);
    await hub.alarm();
    expect(sent).toHaveLength(DELIVERY_BATCH + 3);
  });
});

describe("EventHub housekeeping", () => {
  it("expires subscriptions and forgets old dedupe records", async () => {
    const { hub, sent, clock, fake } = harness();
    const { subscription } = await subscribe(hub, { ...INPUT, ttlSeconds: 3600 });
    await hub.publish([event()]);
    await hub.alarm();
    expect(sent).toHaveLength(1);

    clock.t += 2 * 3600_000;
    // Expired: new events are not queued for it.
    await hub.publish([event("failed")]);
    expect([...fake.data.keys()].some((k) => k.startsWith("q:"))).toBe(false);
    clock.t += HOUSEKEEPING_INTERVAL_MS;
    await hub.alarm();
    expect(await hub.getSubscription(subscription.id)).toMatchObject({ status: "expired" });
    expect((await hub.auditLog())[0]).toMatchObject({ action: "subscription.expired" });

    clock.t += SEEN_RETENTION_MS + HOUSEKEEPING_INTERVAL_MS;
    await hub.alarm();
    expect([...fake.data.keys()].some((k) => k.startsWith("seen:"))).toBe(false);
  });
});
