import { describe, expect, it, vi } from "vitest";
import { assertPublicCallbackUrl } from "../src/events/callback-guard.js";
import type { MultixEvent } from "../src/events/event-catalog.js";
import { EventHub, MAX_ACTIVE_SUBSCRIPTIONS, type Subscription } from "../src/events/event-hub.js";
import {
  CALLBACK_ENDPOINT_ERROR,
  DEFAULT_TTL_MS,
  type EventsContext,
  MAX_TTL_MS,
  MIN_TTL_MS,
} from "../src/events/events-methods.js";
import { verifyWebhook } from "../src/events/webhook-signing.js";
import { JobStore } from "../src/jobs/job-store.js";
import { handleMcpRequest } from "../src/mcp-api-handler.js";
import {
  MODERN_VERSION,
  SECRET,
  callbackRoute,
  dohRoute,
  modernRequest,
  modernRpc,
} from "./events-helpers.js";
import { fakeDoStorage } from "./fake-do-storage.js";
import { fakeKv } from "./fake-kv.js";
import { type RecordedCall, fullEnv, mcpRequest, mockFetch, rpc } from "./helpers.js";

type RpcError = { error: { code: number } };

const HOST = "hooks.example.com";
const CALLBACK = `https://${HOST}/cb`;
const NOW = 1_800_000_000_000;
const JOB_ID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const ORIGIN = "https://mcp.example.com";

function setup(options: { callbackStatus?: number } = {}) {
  const clock = { now: NOW };
  const kv = fakeKv();
  const jobs = new JobStore(kv);
  /** HOST's A records; change them in place to re-point the name. */
  const hostA = ["93.184.216.34"];
  const remote = mockFetch(
    dohRoute(HOST, hostA),
    dohRoute("internal.example.com", ["10.0.0.7"]),
    callbackRoute(HOST, "/cb", options.callbackStatus),
  );
  const hubs = new Map<string, { hub: EventHub; data: Map<string, unknown> }>();
  const hubFor = (userId: string) => {
    let entry = hubs.get(userId);
    if (!entry) {
      const { storage, data } = fakeDoStorage();
      entry = {
        hub: new EventHub({
          storage,
          fetch: remote.fetch,
          checkCallback: (url) => assertPublicCallbackUrl(url, remote.fetch),
          now: () => clock.now,
        }),
        data,
      };
      hubs.set(userId, entry);
    }
    return entry;
  };
  /** The subscription records stored in an account's hub. */
  const stored = (userId: string) =>
    [...hubFor(userId).data]
      .filter(([k]) => k.startsWith("sub:"))
      .map(([, v]) => v as Subscription);
  const contextFor = (userId: string): EventsContext => ({
    userId,
    clientId: "client-1",
    events: hubFor(userId).hub,
    origin: ORIGIN,
    fetch: remote.fetch,
    jobs,
    now: () => clock.now,
  });
  return { clock, hubFor, stored, jobs, remote, contextFor, hostA };
}

function subscribeParams(overrides: Record<string, unknown> = {}) {
  return {
    name: "multix.job.completed",
    arguments: {},
    delivery: { mode: "webhook", url: CALLBACK, secret: SECRET },
    ...overrides,
  };
}

const verifications = (calls: { url: string; method: string }[]) =>
  calls.filter((c) => c.method === "POST" && c.url === CALLBACK).length;

describe("protocol negotiation", () => {
  it("advertises 2026-07-28 and the events capability through server/discover", async () => {
    const { contextFor } = setup();
    const body = await modernRpc(fullEnv(), "server/discover", {}, { events: contextFor("u1") });
    expect(body.result.supportedVersions).toContain(MODERN_VERSION);
    expect(body.result.capabilities.events).toEqual({});
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("multix");
  });

  it("does not advertise events without a subscription store", async () => {
    const body = await modernRpc(fullEnv(), "server/discover");
    expect(body.result.capabilities.events).toBeUndefined();
    const list = await modernRpc(fullEnv(), "events/list");
    expect(list.error.code).toBe(-32601);
  });

  it("serves the tools to modern clients", async () => {
    const list = await modernRpc(fullEnv(), "tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "multix_catalog",
      "multix_skills",
    ]);
    const call = await modernRpc(fullEnv(), "tools/call", {
      name: "multix_catalog",
      arguments: {},
    });
    expect(call.result.isError).toBeFalsy();
    expect(call.result.structuredContent).toBeDefined();
  });

  it("keeps 2025 clients on the tools-only surface", async () => {
    const { contextFor } = setup();
    const deps = { events: contextFor("u1") };
    const init = await rpc(
      fullEnv(),
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "old", version: "0" },
      },
      deps,
    );
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities.events).toBeUndefined();
    const response = await handleMcpRequest(mcpRequest("events/list"), fullEnv(), deps);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(((await response.json()) as RpcError).error.code).toBe(-32601);
  });

  it("answers modern requests as JSON with the security headers", async () => {
    const response = await handleMcpRequest(modernRequest("tools/list"), fullEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("does not open subscriptions/listen streams", async () => {
    const response = await handleMcpRequest(modernRequest("subscriptions/listen"), fullEnv());
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(((await response.json()) as RpcError).error.code).toBe(-32601);
  });

  it("rejects a modern request that is not JSON", async () => {
    const request = modernRequest("tools/list", {}, { "content-type": "text/plain" });
    expect((await handleMcpRequest(request, fullEnv())).status).toBe(415);
  });

  it("rejects an unsupported modern protocol version", async () => {
    const request = modernRequest("tools/list", {}, { "mcp-protocol-version": "2099-01-01" });
    const response = await handleMcpRequest(request, fullEnv());
    const body = (await response.json()) as RpcError;
    expect(body.error).toBeDefined();
  });

  it("still refuses oversized and batched bodies before any parsing", async () => {
    const big = new Request("https://mcp.example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": MODERN_VERSION },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "events/list",
        pad: "x".repeat(70_000),
      }),
    });
    expect((await handleMcpRequest(big, fullEnv())).status).toBe(413);
    const batch = new Request("https://mcp.example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": MODERN_VERSION },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "events/list" }]),
    });
    expect((await handleMcpRequest(batch, fullEnv())).status).toBe(400);
  });
});

describe("events/list", () => {
  it("lists the job lifecycle and asset events with their schemas", async () => {
    const { contextFor } = setup();
    const body = await modernRpc(fullEnv(), "events/list", {}, { events: contextFor("u1") });
    const names = body.result.events.map((e: { name: string }) => e.name);
    expect(names).toEqual([
      "multix.job.completed",
      "multix.job.failed",
      "multix.job.canceled",
      "multix.job.timed_out",
      "multix.asset.ready",
    ]);
    for (const event of body.result.events) {
      expect(event.delivery).toEqual(["webhook"]);
      expect(event.inputSchema.type).toBe("object");
      expect(event.inputSchema.additionalProperties).toBe(false);
      expect(event.payloadSchema.type).toBe("object");
      expect(JSON.stringify(event)).not.toMatch(/\$schema/);
    }
  });
});

describe("events/subscribe", () => {
  it("verifies the callback, stores the subscription in the account's hub and returns its id", async () => {
    const { contextFor, stored, remote } = setup();
    const body = await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), {
      events: contextFor("u1"),
    });
    expect(body.error).toBeUndefined();
    expect(body.result).toMatchObject({
      id: expect.stringMatching(/^sub_[0-9a-f]{24}$/),
      refreshBefore: new Date(NOW + DEFAULT_TTL_MS).toISOString(),
      cursor: null,
      truncated: false,
    });
    expect(verifications(remote.calls)).toBe(1);
    expect(stored("u1")).toEqual([
      expect.objectContaining({
        id: body.result.id,
        callbackUrl: CALLBACK,
        events: ["multix.job.completed"],
        status: "active",
        mcp: { clientId: "client-1" },
      }),
    ]);
  });

  it("refreshes the same subscription when called again, reusing the verification", async () => {
    const { clock, contextFor, stored, remote } = setup();
    const deps = { events: contextFor("u1") };
    const first = await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), deps);
    clock.now += 60_000;
    const again = await modernRpc(
      fullEnv(),
      "events/subscribe",
      subscribeParams({ ttlMs: 2 * 60 * 60_000 }),
      deps,
    );
    expect(again.result.id).toBe(first.result.id);
    expect(again.result.refreshBefore).toBe(new Date(clock.now + 2 * 60 * 60_000).toISOString());
    expect(verifications(remote.calls)).toBe(1);
    const subs = stored("u1");
    expect(subs).toHaveLength(1);
    expect(subs[0]?.createdAt).toBe(NOW);
    expect(subs[0]?.mcp?.previousSecret).toBeUndefined();
  });

  it("keeps the previous secret for a rotation window when the secret changes", async () => {
    const { contextFor, stored, remote } = setup();
    const deps = { events: contextFor("u1") };
    await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), deps);
    const rotated = `whsec_${Buffer.alloc(32, 3).toString("base64")}`;
    await modernRpc(
      fullEnv(),
      "events/subscribe",
      subscribeParams({ delivery: { mode: "webhook", url: CALLBACK, secret: rotated } }),
      deps,
    );
    expect(verifications(remote.calls)).toBe(2);
    const [sub] = stored("u1");
    expect(sub?.secret).toBe(rotated);
    expect(sub?.mcp?.previousSecret).toEqual({ secret: SECRET, until: expect.any(Number) });
    expect(sub?.mcp?.previousSecret?.until).toBeGreaterThan(NOW);
  });

  it("clamps the requested lifetime and never grants an unlimited one", async () => {
    const { contextFor } = setup();
    const deps = { events: contextFor("u1") };
    const short = await modernRpc(
      fullEnv(),
      "events/subscribe",
      subscribeParams({ ttlMs: 1 }),
      deps,
    );
    expect(short.result.refreshBefore).toBe(new Date(NOW + MIN_TTL_MS).toISOString());
    const forever = await modernRpc(
      fullEnv(),
      "events/subscribe",
      subscribeParams({ ttlMs: null }),
      deps,
    );
    expect(forever.result.refreshBefore).toBe(new Date(NOW + MAX_TTL_MS).toISOString());
  });

  it("reports a missed replay cursor as truncated", async () => {
    const { contextFor } = setup();
    const body = await modernRpc(
      fullEnv(),
      "events/subscribe",
      subscribeParams({ cursor: "evt_123" }),
      { events: contextFor("u1") },
    );
    expect(body.result.truncated).toBe(true);
    expect(body.result.cursor).toBeNull();
  });

  it.each([
    ["an unknown event", { name: "multix.nope" }],
    ["an unsupported delivery mode", { delivery: { mode: "sse", url: CALLBACK, secret: SECRET } }],
    [
      "a malformed secret",
      { delivery: { mode: "webhook", url: CALLBACK, secret: "whsec_c2hvcnQ=" } },
    ],
    ["arguments outside the schema", { arguments: { other: 1 } }],
    [
      "an http callback",
      { delivery: { mode: "webhook", url: `http://${HOST}/cb`, secret: SECRET } },
    ],
    [
      "an IP literal callback",
      { delivery: { mode: "webhook", url: "https://10.0.0.1/cb", secret: SECRET } },
    ],
    [
      "a callback resolving to a private address",
      { delivery: { mode: "webhook", url: "https://internal.example.com/cb", secret: SECRET } },
    ],
    [
      "a callback on this server",
      { delivery: { mode: "webhook", url: "https://mcp.example.com/cb", secret: SECRET } },
    ],
    [
      "an oversized secret",
      { delivery: { mode: "webhook", url: CALLBACK, secret: `whsec_${"A".repeat(200)}` } },
    ],
  ])("refuses %s as invalid params without calling the callback", async (_label, overrides) => {
    const { contextFor, remote } = setup();
    const body = await modernRpc(fullEnv(), "events/subscribe", subscribeParams(overrides), {
      events: contextFor("u1"),
    });
    expect(body.error.code).toBe(-32602);
    expect(verifications(remote.calls)).toBe(0);
    expect(remote.calls.some((c) => c.url.includes("10.0.0"))).toBe(false);
  });

  it("returns CallbackEndpointError when verification fails, and stores nothing", async () => {
    const { contextFor, stored } = setup({ callbackStatus: 500 });
    const body = await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), {
      events: contextFor("u1"),
    });
    expect(body.error.code).toBe(CALLBACK_ENDPOINT_ERROR);
    expect(body.error.data).toEqual({ reason: "http_5xx" });
    expect(stored("u1")).toEqual([]);
  });

  it("filters by a job only when the caller owns it", async () => {
    const { contextFor, jobs } = setup();
    await jobs.create(JOB_ID, { userId: "u2", command: "gemini generate", createdAt: NOW });
    const params = subscribeParams({ arguments: { job_id: JOB_ID } });
    const denied = await modernRpc(fullEnv(), "events/subscribe", params, {
      events: contextFor("u1"),
    });
    expect(denied.error.code).toBe(-32602);
    expect(denied.error.message).toContain("Job not found");
    const allowed = await modernRpc(fullEnv(), "events/subscribe", params, {
      events: contextFor("u2"),
    });
    expect(allowed.result.id).toMatch(/^sub_/);
  });

  it(`shares the ${MAX_ACTIVE_SUBSCRIPTIONS}-subscription limit with the REST API`, async () => {
    const { contextFor, hubFor, remote } = setup();
    for (let i = 0; i < MAX_ACTIVE_SUBSCRIPTIONS; i++) {
      await hubFor("u1").hub.subscribe(
        { callbackUrl: CALLBACK, events: ["multix.job.failed"], ttlSeconds: 3600 },
        "api_key:k1",
      );
    }
    const body = await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), {
      events: contextFor("u1"),
    });
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain("at most");
    expect(verifications(remote.calls)).toBe(0);
  });

  it("logs the subscribed event without replacing the log event name", async () => {
    const { contextFor } = setup();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), {
        events: contextFor("u1"),
      });
      const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(lines).toContainEqual(
        expect.objectContaining({ event: "event_subscribe", eventName: "multix.job.completed" }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("refuses a subscription that loses the race for the last slot", async () => {
    const { contextFor, hubFor } = setup();
    const events = contextFor("u1");
    // The count check passes, but the hub is full by the time the write lands.
    events.events = {
      ...events.events,
      mcpSubscriptionState: (...args) => hubFor("u1").hub.mcpSubscriptionState(...args),
      upsertMcpSubscription: async () => ({
        ok: false,
        error: "limit_reached",
        message: "An account may have at most 10 active subscriptions",
      }),
    };
    const body = await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), { events });
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain("at most");
  });

  it("refuses a client whose connection was just revoked", async () => {
    const { contextFor, hubFor, stored } = setup();
    await hubFor("u1").hub.removeByClient("client-1", "dashboard:u1");
    const body = await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), {
      events: contextFor("u1"),
    });
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toContain("revoked");
    expect(stored("u1")).toEqual([]);
  });

  it("verifies again when the subscription stops being live before the refresh lands", async () => {
    const { contextFor, hubFor, remote, clock } = setup();
    const deps = { events: contextFor("u1") };
    await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), deps);
    expect(verifications(remote.calls)).toBe(1);
    // The state still reads verified, but the record expires before the write.
    const hub = hubFor("u1").hub;
    const original = hub.mcpSubscriptionState.bind(hub);
    deps.events.events.mcpSubscriptionState = async (...args) => {
      const state = await original(...args);
      clock.now += 2 * DEFAULT_TTL_MS;
      return state;
    };
    const body = await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), deps);
    expect(body.result.id).toMatch(/^sub_/);
    expect(verifications(remote.calls)).toBe(2);
  });

  it("answers an unexpected failure with a generic internal error", async () => {
    const { contextFor } = setup();
    const events = contextFor("u1");
    events.events.mcpSubscriptionState = async () => {
      throw new Error("storage failed at /internal/path for sub:abc");
    };
    const body = await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), { events });
    expect(body.error).toEqual({ code: -32603, message: "Internal error" });
  });
});

describe("events/unsubscribe", () => {
  it("removes the subscription and is idempotent", async () => {
    const { contextFor, stored } = setup();
    const deps = { events: contextFor("u1") };
    await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), deps);
    const target = {
      name: "multix.job.completed",
      arguments: {},
      delivery: { mode: "webhook", url: CALLBACK },
    };
    expect((await modernRpc(fullEnv(), "events/unsubscribe", target, deps)).result).toMatchObject({
      resultType: "complete",
    });
    expect(stored("u1")).toEqual([]);
    expect((await modernRpc(fullEnv(), "events/unsubscribe", target, deps)).error).toBeUndefined();
  });

  it.each([
    { name: "multix.job.unknown" },
    { delivery: { mode: "sse", url: CALLBACK } },
    { arguments: { job_id: 5 } },
    { delivery: { mode: "webhook", url: "http://127.0.0.1/cb" } },
  ])("answers an unsubscribe for a target that cannot exist with success: %j", async (change) => {
    const { contextFor } = setup();
    const target = {
      name: "multix.job.completed",
      arguments: {},
      delivery: { mode: "webhook", url: CALLBACK },
      ...change,
    };
    const body = await modernRpc(fullEnv(), "events/unsubscribe", target, {
      events: contextFor("u1"),
    });
    expect(body.error).toBeUndefined();
    expect(body.result).toMatchObject({ resultType: "complete" });
  });

  it("cannot remove or see another account's subscription", async () => {
    const { contextFor, stored } = setup();
    await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), { events: contextFor("u1") });
    const target = {
      name: "multix.job.completed",
      arguments: {},
      delivery: { mode: "webhook", url: CALLBACK },
    };
    await modernRpc(fullEnv(), "events/unsubscribe", target, { events: contextFor("u2") });
    expect(stored("u1")).toHaveLength(1);
    expect(stored("u2")).toEqual([]);
  });
});

function jobEvent(
  name: MultixEvent["name"],
  jobId: string,
  id = `evt_${jobId}_${name}`,
): MultixEvent {
  return {
    id,
    name,
    schema_version: 1,
    occurred_at: new Date(NOW).toISOString(),
    resource: { type: "job", id: jobId },
    data: {
      job_id: jobId,
      status: "succeeded",
      command: "gemini generate",
      provider: "gemini",
      created_at: new Date(NOW - 60_000).toISOString(),
      finished_at: new Date(NOW).toISOString(),
      exit_code: 0,
      outputs: [],
    },
  };
}

describe("event delivery to MCP subscribers", () => {
  const deliveries = (calls: RecordedCall[]) =>
    calls.filter(
      (c) => c.method === "POST" && c.url === CALLBACK && !(c.body as { type?: string }).type,
    );

  it("sends nothing to a callback re-pointed at a private address after subscribing", async () => {
    const { contextFor, hubFor, remote, hostA } = setup();
    const sub = await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), {
      events: contextFor("u1"),
    });
    expect(sub.error).toBeUndefined();
    hostA.splice(0, hostA.length, "10.0.0.1");
    const { hub } = hubFor("u1");
    await hub.publish([jobEvent("multix.job.completed", JOB_ID)]);
    await hub.alarm();
    expect(deliveries(remote.calls)).toEqual([]);
    const [[, retry]] = [...hubFor("u1").data].filter(([k]) => k.startsWith("q:")) as [
      [string, { lastError?: string }],
    ];
    expect(retry.lastError).toBe("endpoint address not public");
  });

  it("sends the MCP Events body, signed, with the subscription id header", async () => {
    const { contextFor, hubFor, remote } = setup();
    const sub = await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), {
      events: contextFor("u1"),
    });
    const { hub } = hubFor("u1");
    await hub.publish([jobEvent("multix.job.completed", JOB_ID)]);
    await hub.alarm();

    const [delivery] = deliveries(remote.calls);
    expect(delivery?.body).toEqual({
      eventId: `evt_${JOB_ID}_multix.job.completed`,
      name: "multix.job.completed",
      timestamp: new Date(NOW).toISOString(),
      data: expect.objectContaining({ job_id: JOB_ID, status: "succeeded" }),
      cursor: null,
    });
    expect(delivery?.headers["x-mcp-subscription-id"]).toBe(sub.result.id);
    expect(delivery?.headers["webhook-id"]).toBe(`evt_${JOB_ID}_multix.job.completed`);
    const valid = await verifyWebhook(
      SECRET,
      {
        id: delivery?.headers["webhook-id"] as string,
        timestamp: delivery?.headers["webhook-timestamp"] as string,
        signature: delivery?.headers["webhook-signature"] as string,
      },
      JSON.stringify(delivery?.body),
      Math.floor(NOW / 1000),
    );
    expect(valid).toBe(true);
  });

  it("delivers only the subscribed job's events when narrowed by job_id", async () => {
    const { contextFor, hubFor, jobs, remote } = setup();
    await jobs.create(JOB_ID, { userId: "u1", command: "gemini generate", createdAt: NOW });
    await modernRpc(
      fullEnv(),
      "events/subscribe",
      subscribeParams({ arguments: { job_id: JOB_ID } }),
      { events: contextFor("u1") },
    );
    const { hub } = hubFor("u1");
    await hub.publish([
      jobEvent("multix.job.completed", "11111111-2222-4333-8444-555555555555"),
      jobEvent("multix.job.completed", JOB_ID),
    ]);
    await hub.alarm();
    const sent = deliveries(remote.calls);
    expect(sent).toHaveLength(1);
    expect((sent[0]?.body as { data: { job_id: string } }).data.job_id).toBe(JOB_ID);
  });

  it("signs with the old and the new secret during the rotation window", async () => {
    const { contextFor, hubFor, remote } = setup();
    const deps = { events: contextFor("u1") };
    await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), deps);
    const rotated = `whsec_${Buffer.alloc(32, 3).toString("base64")}`;
    await modernRpc(
      fullEnv(),
      "events/subscribe",
      subscribeParams({ delivery: { mode: "webhook", url: CALLBACK, secret: rotated } }),
      deps,
    );
    const { hub } = hubFor("u1");
    await hub.publish([jobEvent("multix.job.completed", JOB_ID)]);
    await hub.alarm();
    const [delivery] = deliveries(remote.calls);
    const headers = {
      id: delivery?.headers["webhook-id"] as string,
      timestamp: delivery?.headers["webhook-timestamp"] as string,
      signature: delivery?.headers["webhook-signature"] as string,
    };
    expect(headers.signature.split(" ")).toHaveLength(2);
    const body = JSON.stringify(delivery?.body);
    for (const secret of [SECRET, rotated]) {
      expect(await verifyWebhook(secret, headers, body, Math.floor(NOW / 1000))).toBe(true);
    }
  });
});
