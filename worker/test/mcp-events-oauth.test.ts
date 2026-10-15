import { describe, expect, it } from "vitest";
import { SECRET, callbackRoute, dohRoute } from "./events-helpers.js";
import { fakeEventsNamespace } from "./fake-job-bindings.js";
import {
  authorizeAndGetToken,
  githubFetch,
  hiddenField,
  mcpCall,
  modernMcpCall,
  newBrowser,
  oauthEnv,
  registerClient,
} from "./oauth-harness.js";

const OCTOCAT = { id: 583231, login: "octocat" };
const HUBOT = { id: 2, login: "hubot" };
const HOST = "hooks.example.com";
const CALLBACK = `https://${HOST}/cb`;
const TARGET = {
  name: "multix.job.failed",
  arguments: {},
  delivery: { mode: "webhook", url: CALLBACK },
};
const SUBSCRIBE = { ...TARGET, delivery: { ...TARGET.delivery, secret: SECRET } };

function eventsEnv() {
  const events = fakeEventsNamespace();
  const env = oauthEnv({
    MULTIX_ALLOWED_USERS: "octocat,hubot",
    MULTIX_EVENTS: events.namespace,
  });
  /** Every account's subscriptions, by account. */
  const subscriptions = async () =>
    Promise.all(
      [...events.hubs].map(async ([account, hub]) => ({
        account,
        subs: await hub.listSubscriptions(),
      })),
    );
  return { env, subscriptions };
}

const remote = () => [dohRoute(HOST, ["93.184.216.34"]), callbackRoute(HOST)];

async function json(response: Response) {
  expect(response.headers.get("content-type")).toContain("application/json");
  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC payloads are untyped in tests
  return (await response.json()) as any;
}

describe("MCP Events over OAuth", () => {
  it("negotiates 2026-07-28 and subscribes for the token's account", async () => {
    const { env, subscriptions } = eventsEnv();
    const browser = newBrowser(env, githubFetch(OCTOCAT, ...remote()).fetch);
    const token = await authorizeAndGetToken(browser, await registerClient(browser));

    const discover = await json(await modernMcpCall(browser, token, "server/discover"));
    expect(discover.result.capabilities.events).toEqual({});

    const subscribed = await json(
      await modernMcpCall(browser, token, "events/subscribe", SUBSCRIBE),
    );
    expect(subscribed.result.id).toMatch(/^sub_/);
    expect(await subscriptions()).toEqual([
      {
        account: expect.any(String),
        subs: [expect.objectContaining({ id: subscribed.result.id, events: [TARGET.name] })],
      },
    ]);

    // The 2025 handshake on the same token still sees tools only.
    const init = await json(
      await mcpCall(browser, token, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "old", version: "0" },
      }),
    );
    expect(init.result.capabilities.events).toBeUndefined();
  });

  it("requires a token for events and refuses a revoked one", async () => {
    const { env, subscriptions } = eventsEnv();
    const browser = newBrowser(env, githubFetch(OCTOCAT, ...remote()).fetch);
    expect((await modernMcpCall(browser, undefined, "events/list")).status).toBe(401);

    const token = await authorizeAndGetToken(browser, await registerClient(browser));
    expect((await modernMcpCall(browser, token, "events/list")).status).toBe(200);
    const page = await (await browser.request("/dashboard")).text();
    await browser.post("/dashboard/connections/revoke", {
      csrf: hiddenField(page, "csrf"),
      grant_id: hiddenField(page, "grant_id"),
    });
    expect((await modernMcpCall(browser, token, "events/subscribe", SUBSCRIBE)).status).toBe(401);
    for (const { subs } of await subscriptions()) expect(subs).toEqual([]);
  });

  it("removes the client's subscriptions when its connection is revoked", async () => {
    const { env, subscriptions } = eventsEnv();
    const browser = newBrowser(env, githubFetch(OCTOCAT, ...remote()).fetch);
    const token = await authorizeAndGetToken(browser, await registerClient(browser));
    const created = await json(await modernMcpCall(browser, token, "events/subscribe", SUBSCRIBE));
    expect(created.result.id).toMatch(/^sub_/);
    expect((await subscriptions()).map((a) => a.subs.length)).toEqual([1]);

    const page = await (await browser.request("/dashboard")).text();
    await browser.post("/dashboard/connections/revoke", {
      csrf: hiddenField(page, "csrf"),
      grant_id: hiddenField(page, "grant_id"),
    });
    expect((await subscriptions()).map((a) => a.subs.length)).toEqual([0]);
  });

  it("keeps each account's subscriptions apart", async () => {
    const { env, subscriptions } = eventsEnv();
    const owner = newBrowser(env, githubFetch(OCTOCAT, ...remote()).fetch);
    const ownerToken = await authorizeAndGetToken(owner, await registerClient(owner));
    const mine = await json(await modernMcpCall(owner, ownerToken, "events/subscribe", SUBSCRIBE));

    const other = newBrowser(env, githubFetch(HUBOT, ...remote()).fetch);
    const otherToken = await authorizeAndGetToken(other, await registerClient(other));
    await modernMcpCall(other, otherToken, "events/unsubscribe", TARGET);
    const theirs = await json(
      await modernMcpCall(other, otherToken, "events/subscribe", SUBSCRIBE),
    );

    expect(theirs.result.id).not.toBe(mine.result.id);
    expect((await subscriptions()).map((a) => a.subs.length)).toEqual([1, 1]);
  });
});
