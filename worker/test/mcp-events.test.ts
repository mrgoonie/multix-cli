import { describe, expect, it } from "vitest";
import { importEncryptionKey } from "../src/accounts/provider-secret-crypto.js";
import { MAX_SUBSCRIPTIONS_PER_ACCOUNT } from "../src/events/event-subscriptions.js";
import {
  CALLBACK_ENDPOINT_ERROR,
  DEFAULT_TTL_MS,
  type EventsContext,
  MAX_TTL_MS,
  MIN_TTL_MS,
} from "../src/events/events-methods.js";
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
import { fakeEventSubscriptions } from "./fake-event-subscriptions.js";
import { fakeKv } from "./fake-kv.js";
import { fullEnv, mcpRequest, mockFetch, rpc } from "./helpers.js";

type RpcError = { error: { code: number } };

const HOST = "hooks.example.com";
const CALLBACK = `https://${HOST}/cb`;
const NOW = 1_800_000_000_000;
const JOB_ID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

function setup(options: { callbackStatus?: number; now?: () => number } = {}) {
  const namespace = fakeEventSubscriptions();
  const kv = fakeKv();
  const jobs = new JobStore(kv);
  const remote = mockFetch(
    dohRoute(HOST, ["93.184.216.34"]),
    dohRoute("internal.example.com", ["10.0.0.7"]),
    callbackRoute(HOST, "/cb", options.callbackStatus),
  );
  const contextFor = (userId: string): EventsContext => ({
    userId,
    clientId: "client-1",
    subscriptions: namespace.getByName(userId),
    encryptionKey: importEncryptionKey(ENCRYPTION_KEY),
    fetch: remote.fetch,
    jobs,
    now: options.now ?? (() => NOW),
  });
  return { namespace, jobs, remote, contextFor };
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
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["multix_catalog"]);
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
  it("verifies the callback, stores the subscription encrypted and returns its id", async () => {
    const { contextFor, namespace, remote } = setup();
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
    const stored = [...namespace.storage("u1").data.values()];
    expect(JSON.stringify(stored)).not.toContain(SECRET.slice(6));
    const [sub] = await namespace.getByName("u1").list(NOW);
    expect(sub).toMatchObject({
      url: CALLBACK,
      name: "multix.job.completed",
      clientId: "client-1",
    });
  });

  it("refreshes the same subscription when called again, reusing the verification", async () => {
    let now = NOW;
    const { contextFor, namespace, remote } = setup({ now: () => now });
    const deps = { events: contextFor("u1") };
    const first = await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), deps);
    now += 60_000;
    const again = await modernRpc(
      fullEnv(),
      "events/subscribe",
      subscribeParams({ ttlMs: 2 * 60 * 60_000 }),
      deps,
    );
    expect(again.result.id).toBe(first.result.id);
    expect(again.result.refreshBefore).toBe(new Date(now + 2 * 60 * 60_000).toISOString());
    expect(verifications(remote.calls)).toBe(1);
    const subs = await namespace.getByName("u1").list(now);
    expect(subs).toHaveLength(1);
    expect(subs[0]?.createdAt).toBe(NOW);
    expect(subs[0]?.previousSecret).toBeUndefined();
  });

  it("keeps the previous secret for a rotation window when the secret changes", async () => {
    const { contextFor, namespace, remote } = setup();
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
    const [sub] = await namespace.getByName("u1").list(NOW);
    expect(sub?.previousSecret?.until).toBeGreaterThan(NOW);
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
    const { contextFor, namespace } = setup({ callbackStatus: 500 });
    const body = await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), {
      events: contextFor("u1"),
    });
    expect(body.error.code).toBe(CALLBACK_ENDPOINT_ERROR);
    expect(body.error.data).toEqual({ reason: "http_5xx" });
    expect(await namespace.getByName("u1").list(NOW)).toEqual([]);
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

  it(`caps an account at ${MAX_SUBSCRIPTIONS_PER_ACCOUNT} subscriptions`, async () => {
    const { contextFor, namespace } = setup();
    const deps = { events: contextFor("u1") };
    const store = namespace.getByName("u1");
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_ACCOUNT; i++) {
      const record = { id: `sub_${i}`, name: "multix.job.failed", arguments: {}, url: CALLBACK };
      await store.upsert(
        {
          ...record,
          secret: { v: 1, iv: "", ct: "" },
          createdAt: NOW,
          updatedAt: NOW,
          expiresAt: NOW + 60_000,
        },
        NOW,
      );
    }
    const body = await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), deps);
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain("limit");
  });
});

describe("events/unsubscribe", () => {
  it("removes the subscription and is idempotent", async () => {
    const { contextFor, namespace } = setup();
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
    expect(await namespace.getByName("u1").list(NOW)).toEqual([]);
    expect((await modernRpc(fullEnv(), "events/unsubscribe", target, deps)).error).toBeUndefined();
  });

  it("cannot remove or see another account's subscription", async () => {
    const { contextFor, namespace } = setup();
    await modernRpc(fullEnv(), "events/subscribe", subscribeParams(), { events: contextFor("u1") });
    const target = {
      name: "multix.job.completed",
      arguments: {},
      delivery: { mode: "webhook", url: CALLBACK },
    };
    await modernRpc(fullEnv(), "events/unsubscribe", target, { events: contextFor("u2") });
    expect(await namespace.getByName("u1").list(NOW)).toHaveLength(1);
    expect(await namespace.getByName("u2").list(NOW)).toEqual([]);
  });
});
