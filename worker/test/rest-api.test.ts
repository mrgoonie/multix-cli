import { describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/accounts/api-key-store.js";
import { openApiDocument } from "../src/api/openapi-document.js";
import type { EventHub } from "../src/events/event-hub.js";
import { jobEvents } from "../src/events/job-events.js";
import { fakeEventsNamespace, fakeNamespace, fakeQuotaNamespace } from "./fake-job-bindings.js";
import { fakeKv } from "./fake-kv.js";
import { jsonResponse, route } from "./helpers.js";
import {
  type Browser,
  ORIGIN,
  githubFetch,
  hiddenField,
  newBrowser,
  oauthEnv,
  signIn,
} from "./oauth-harness.js";

const OCTOCAT = { id: 1, login: "octocat" };

/**
 * DNS-over-HTTPS answers for callback checks: `private.example.com` resolves
 * to 10.0.0.1, `dnsfail.example.com` fails (SERVFAIL), any other name to a
 * public address.
 */
const dns = route("GET", /^https:\/\/cloudflare-dns\.com\/dns-query\?/, (call) => {
  const url = new URL(call.url);
  const name = url.searchParams.get("name");
  if (name === "dnsfail.example.com") return jsonResponse({ Status: 2 });
  if (url.searchParams.get("type") !== "A") return jsonResponse({ Status: 0, Answer: [] });
  const data = name === "private.example.com" ? "10.0.0.1" : "93.184.216.34";
  return jsonResponse({ Status: 0, Answer: [{ type: 1, data }] });
});

// biome-ignore lint/suspicious/noExplicitAny: JSON response bodies are untyped in tests
type Json = any;

const body = (response: Response): Promise<Json> => response.json();
const GEMINI_KEY = "AIza-gemini-secret-value-1234";
const OPENAI_KEY = "sk-openai-secret-value-123456";

/** Sign in, create an API key from the dashboard and read it from the one-time display. */
async function createApiKey(browser: Browser, name = "ci"): Promise<string> {
  const dashboard = await (await browser.request("/dashboard")).text();
  const created = await browser.post("/dashboard/api-keys", {
    csrf: hiddenField(dashboard, "csrf"),
    name,
    intent: "create",
  });
  expect(created.status).toBe(200);
  const page = await created.text();
  expect(page).toContain('aria-label="Copy New API key"');
  const match = /id="new-api-key-value" readonly value="(mxk_[A-Za-z0-9_-]{43})"/.exec(page);
  if (!match?.[1]) throw new Error("no new key on the page");
  return match[1];
}

function api(browser: Browser, key: string | undefined, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (key) headers.set("authorization", `Bearer ${key}`);
  if (init.body) headers.set("content-type", "application/json");
  return browser.request(`/api/v1${path}`, { ...init, headers });
}

async function signedInBrowser(overrides = {}) {
  const env = oauthEnv(overrides);
  const browser = newBrowser(env, githubFetch(OCTOCAT, dns).fetch);
  await signIn(browser);
  return { env, browser };
}

describe("REST API keys", () => {
  it("shows a new key once, stores only its hash, and lists it without the value", async () => {
    const { env, browser } = await signedInBrowser();
    const key = await createApiKey(browser, "laptop");
    const kv = JSON.stringify([
      ...(env.ACCOUNTS_KV as unknown as { dump(): Map<string, unknown> }).dump(),
    ]);
    expect(kv).not.toContain(key);
    const dashboard = await (await browser.request("/dashboard")).text();
    expect(dashboard).toContain("laptop");
    expect(dashboard).not.toContain(key);

    const list = await body(await api(browser, key, "/api-keys"));
    expect(list.api_keys).toHaveLength(1);
    expect(list.api_keys[0]).toMatchObject({ name: "laptop", prefix: key.slice(0, 12) });
    expect(JSON.stringify(list)).not.toContain(key);
  });

  it("rejects missing, malformed and revoked keys", async () => {
    const { browser } = await signedInBrowser();
    expect((await api(browser, undefined, "/me")).status).toBe(401);
    expect((await api(browser, "mxk_not-a-real-key", "/me")).status).toBe(401);
    const key = await createApiKey(browser);
    const me = await api(browser, key, "/me");
    expect(me.status).toBe(200);
    const me1 = await body(me);
    expect(me1).toMatchObject({ id: "gh-1", login: "octocat" });

    const revoked = await api(browser, key, `/api-keys/${me1.api_key_id}`, { method: "DELETE" });
    expect(revoked.status).toBe(200);
    const after = await api(browser, key, "/me");
    expect(after.status).toBe(401);
    expect(await after.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("revokes from the dashboard and stops a key whose account left the allowlist", async () => {
    const { env, browser } = await signedInBrowser();
    const key = await createApiKey(browser);
    env.MULTIX_ALLOWED_USERS = "someone-else";
    expect((await api(browser, key, "/me")).status).toBe(403);
  });

  it("keeps every key listed when keys are created at the same time", async () => {
    const store = new ApiKeyStore(fakeKv());
    const created = await Promise.all(["a", "b", "c"].map((name) => store.create("gh-1", name)));
    expect((await store.list("gh-1")).map((r) => r.name).sort()).toEqual(["a", "b", "c"]);
    expect(await store.list("gh-12")).toEqual([]);
    expect(await store.revoke("gh-2", created[0]?.record.id ?? "")).toBe(false);
    expect(await store.revoke("gh-1", created[0]?.record.id ?? "")).toBe(true);
    expect(await store.verify(created[0]?.key ?? "")).toBeNull();
    expect(await store.verify(created[1]?.key ?? "")).toMatchObject({ userId: "gh-1" });
  });

  it("says so when a dashboard revoke matches no key", async () => {
    const { browser } = await signedInBrowser();
    const key = await createApiKey(browser);
    const { api_key_id: id } = await body(await api(browser, key, "/me"));
    const dashboard = await (await browser.request("/dashboard")).text();
    const revoke = (keyId: string) =>
      browser.post("/dashboard/api-keys", {
        csrf: hiddenField(dashboard, "csrf"),
        intent: "revoke",
        id: keyId,
      });
    expect((await revoke("no-such-key")).headers.get("location")).toContain("api-key-not-found");
    expect((await revoke(id)).headers.get("location")).toContain("api-key-revoked");
    expect((await api(browser, key, "/me")).status).toBe(401);
  });
});

describe("REST API account endpoints", () => {
  it("sets provider keys in bulk, never returns values, and validates before writing", async () => {
    const { env, browser } = await signedInBrowser();
    const key = await createApiKey(browser);
    const patch = (keys: Record<string, unknown>) =>
      api(browser, key, "/provider-keys", { method: "PATCH", body: JSON.stringify({ keys }) });

    const saved = await patch({ GEMINI_API_KEY: GEMINI_KEY, OPENAI_API_KEY: OPENAI_KEY });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      saved: ["GEMINI_API_KEY", "OPENAI_API_KEY"],
      removed: [],
    });

    const bad = await patch({ GEMINI_API_KEY: null, NOT_A_KEY: "x" });
    expect(bad.status).toBe(400);
    const badBody = await bad.text();
    expect(badBody).toContain("NOT_A_KEY");
    const spaced = await patch({ OPENAI_API_KEY: "has spaces in it" });
    expect(spaced.status).toBe(400);
    expect(await spaced.text()).not.toContain("has spaces");

    const list = await body(await api(browser, key, "/provider-keys"));
    const status = Object.fromEntries(
      list.keys.map((k: { name: string; set: boolean }) => [k.name, k.set]),
    );
    // The rejected PATCH removed nothing.
    expect(status).toMatchObject({ GEMINI_API_KEY: true, OPENAI_API_KEY: true });
    expect(JSON.stringify(list)).not.toContain(GEMINI_KEY);

    expect(
      (await api(browser, key, "/provider-keys/OPENAI_API_KEY", { method: "DELETE" })).status,
    ).toBe(200);
    const one = await api(browser, key, "/provider-keys/OPENAI_API_KEY", {
      method: "PUT",
      body: JSON.stringify({ value: OPENAI_KEY }),
    });
    expect(await one.json()).toEqual({ saved: ["OPENAI_API_KEY"], removed: [] });

    const stored = JSON.stringify([
      ...(env.ACCOUNTS_KV as unknown as { dump(): Map<string, unknown> }).dump(),
    ]);
    expect(stored).not.toContain(GEMINI_KEY);
    expect(stored).not.toContain(OPENAI_KEY);
  });

  it("needs a JSON body and reports storage validation without echoing values", async () => {
    const { browser } = await signedInBrowser();
    const key = await createApiKey(browser);
    const form = await browser.request("/api/v1/storage", {
      method: "PUT",
      headers: { authorization: `Bearer ${key}`, "content-type": "text/plain" },
      body: "x",
    });
    expect(form.status).toBe(415);
    const invalid = await api(browser, key, "/storage", {
      method: "PUT",
      body: JSON.stringify({
        account_id: "nothex",
        access_key_id: "AKIA-secret-ish-value",
        secret_access_key: "very-secret-value-0000",
        bucket: "b",
      }),
    });
    expect(invalid.status).toBe(400);
    const text = await invalid.text();
    expect(text).toContain("account_id");
    expect(text).not.toContain("very-secret-value-0000");
    const badPrefix = await api(browser, key, "/storage", {
      method: "PUT",
      body: JSON.stringify({
        account_id: "0123456789abcdef0123456789abcdef",
        access_key_id: "AKIDEXAMPLE0123456789",
        secret_access_key: "very-secret-value-0000",
        bucket: "my-bucket",
        prefix: "out/../etc",
      }),
    });
    expect(badPrefix.status).toBe(400);
    expect(await badPrefix.text()).toContain("prefix may only use");
    expect(await body(await api(browser, key, "/storage"))).toEqual({ configured: false });
  });

  it("answers unknown paths and wrong methods with JSON errors", async () => {
    const { browser } = await signedInBrowser();
    const key = await createApiKey(browser);
    const missing = await api(browser, key, "/nope");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
    const wrong = await api(browser, key, "/me", { method: "POST" });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET");
  });
});

describe("REST API jobs", () => {
  it("runs a CLI command with the account's keys and scrubs them from the output", async () => {
    const { namespace, specs } = fakeNamespace();
    const { browser } = await signedInBrowser({
      MULTIX_JOBS: namespace,
      MULTIX_JOB_QUOTA: fakeQuotaNamespace(),
    });
    const key = await createApiKey(browser);
    await api(browser, key, "/provider-keys", {
      method: "PATCH",
      body: JSON.stringify({ keys: { GEMINI_API_KEY: GEMINI_KEY } }),
    });
    const catalog = await body(await api(browser, key, "/catalog?group=gemini"));
    expect(catalog.has_keys).toBe(true);
    const speech = await body(await api(browser, key, "/catalog?task=speech&group=gemini"));
    expect(speech.commands).toEqual([
      expect.objectContaining({ command: "gemini generate-speech" }),
    ]);
    const model = await body(await api(browser, key, "/catalog?model=elevenlabs/tts/eleven-v4"));
    expect(model.verified.inputs.text.required).toBe(true);
    expect((await api(browser, key, "/catalog?task=telepathy")).status).toBe(400);
    expect((await api(browser, key, "/catalog?model=bad%20id")).status).toBe(400);

    const run = await api(browser, key, "/jobs", {
      method: "POST",
      body: JSON.stringify({ command: "gemini generate", options: { prompt: "a cat" } }),
    });
    expect(run.status).toBe(200);
    const job = await body(run);
    expect(job).toMatchObject({ status: "succeeded", stdout: "key=[redacted]" });
    expect(specs.get(job.job_id)?.env).toEqual({ GEMINI_API_KEY: GEMINI_KEY });

    const status = await api(browser, key, `/jobs/${job.job_id}`);
    expect(status.status).toBe(200);
    expect((await body(status)).status).toBe("succeeded");

    const bad = await api(browser, key, "/jobs", {
      method: "POST",
      body: JSON.stringify({ command: "gemini generate", wait_seconds: 999 }),
    });
    expect(bad.status).toBe(400);
  });

  it("does not show another account's job", async () => {
    const { namespace } = fakeNamespace();
    const env = oauthEnv({
      MULTIX_ALLOWED_USERS: "octocat,hubot",
      MULTIX_JOBS: namespace,
      MULTIX_JOB_QUOTA: fakeQuotaNamespace(),
    });
    const owner = newBrowser(env, githubFetch(OCTOCAT, dns).fetch);
    await signIn(owner);
    const ownerKey = await createApiKey(owner);
    const job = await body(
      await api(owner, ownerKey, "/jobs", {
        method: "POST",
        body: JSON.stringify({ command: "gemini generate", options: { prompt: "p" } }),
      }),
    );

    const other = newBrowser(env, githubFetch({ id: 2, login: "hubot" }, dns).fetch);
    await signIn(other);
    const otherKey = await createApiKey(other);
    expect((await api(other, otherKey, `/jobs/${job.job_id}`)).status).toBe(404);
  });

  it("refuses a run the caps cannot bound unless its price is proven within max_cost_usd", async () => {
    const { namespace, specs } = fakeNamespace();
    const { browser } = await signedInBrowser({
      MULTIX_JOBS: namespace,
      MULTIX_JOB_QUOTA: fakeQuotaNamespace(),
    });
    const key = await createApiKey(browser);
    const falRun = { command: "fal run", args: ["fal-ai/any-model"], options: { input: "{}" } };
    const post = (extra: Record<string, unknown>) =>
      api(browser, key, "/jobs", { method: "POST", body: JSON.stringify({ ...falRun, ...extra }) });

    const missing = await post({});
    expect(missing.status).toBe(400);
    expect((await body(missing)).error.message).toContain("Pass max_cost_usd");
    const unknown = await post({ max_cost_usd: 1 });
    expect(unknown.status).toBe(400);
    expect((await body(unknown)).error.message).toMatch(/^Refusing to run: cost of .* is unknown/);
    const text = await post({ max_cost_usd: "1" });
    expect(text.status).toBe(400);
    expect((await body(text)).error.message).toBe(
      "max_cost_usd must be a number of USD, at least 0",
    );
    const loose = await post({ cost_policy: "loose" });
    expect(loose.status).toBe(400);
    expect((await body(loose)).error.message).toBe("cost_policy must be strict or estimate");
    expect(specs.size).toBe(0);
  });

  it("reports jobs as unavailable without the job bindings", async () => {
    const { browser } = await signedInBrowser();
    const key = await createApiKey(browser);
    const run = await api(browser, key, "/jobs", {
      method: "POST",
      body: JSON.stringify({ command: "gemini generate", options: { prompt: "p" } }),
    });
    expect(run.status).toBe(503);
  });
});

describe("REST API events", () => {
  const CALLBACK = "https://hooks.example.com/multix?token=abc";

  it("creates, lists, reads and revokes a subscription, showing the secret only once", async () => {
    const events = fakeEventsNamespace();
    const { browser } = await signedInBrowser({ MULTIX_EVENTS: events.namespace });
    const key = await createApiKey(browser);

    const catalog = await body(await api(browser, key, "/events"));
    expect(catalog.events.map((e: Json) => e.name)).toContain("multix.job.completed");

    const created = await api(browser, key, "/events/subscriptions", {
      method: "POST",
      body: JSON.stringify({ callback_url: CALLBACK, events: ["multix.job.failed"] }),
    });
    expect(created.status).toBe(201);
    const { subscription, secret, signing } = await body(created);
    expect(secret).toMatch(/^whsec_/);
    expect(signing.headers).toEqual(["webhook-id", "webhook-timestamp", "webhook-signature"]);
    expect(subscription).toMatchObject({ status: "active", events: ["multix.job.failed"] });
    expect(subscription.callback_url).not.toContain("abc");

    const listed = await api(browser, key, "/events/subscriptions");
    const listText = await listed.text();
    expect(JSON.parse(listText).subscriptions).toHaveLength(1);
    expect(listText).not.toContain(secret);
    const one = await body(await api(browser, key, `/events/subscriptions/${subscription.id}`));
    expect(one.subscription.id).toBe(subscription.id);

    const revoked = await api(browser, key, `/events/subscriptions/${subscription.id}`, {
      method: "DELETE",
    });
    expect(await body(revoked)).toEqual({ revoked: subscription.id });
    expect((await api(browser, key, `/events/subscriptions/${subscription.id}`)).status).toBe(404);
    expect(
      (await api(browser, key, `/events/subscriptions/${subscription.id}`, { method: "DELETE" }))
        .status,
    ).toBe(404);

    const audit = await body(await api(browser, key, "/events/audit"));
    expect(audit.audit.map((e: Json) => e.action)).toEqual([
      "subscription.revoked",
      "subscription.created",
    ]);
    expect(audit.audit[0].actor).toMatch(/^api_key:/);
    expect(await body(await api(browser, key, "/events/dead-letters"))).toEqual({
      dead_letters: [],
    });
  });

  it("keeps each account's subscriptions and deliveries to itself", async () => {
    const events = fakeEventsNamespace();
    const env = oauthEnv({
      MULTIX_ALLOWED_USERS: "octocat,hubot",
      MULTIX_EVENTS: events.namespace,
    });
    const owner = newBrowser(env, githubFetch(OCTOCAT, dns).fetch);
    await signIn(owner);
    const ownerKey = await createApiKey(owner);
    const { subscription } = await body(
      await api(owner, ownerKey, "/events/subscriptions", {
        method: "POST",
        body: JSON.stringify({ callback_url: "https://owner.example.com/in" }),
      }),
    );

    const other = newBrowser(env, githubFetch({ id: 2, login: "hubot" }, dns).fetch);
    await signIn(other);
    const otherKey = await createApiKey(other);
    const path = `/events/subscriptions/${subscription.id}`;
    expect((await api(other, otherKey, path)).status).toBe(404);
    expect((await api(other, otherKey, path, { method: "DELETE" })).status).toBe(404);
    expect(await body(await api(other, otherKey, "/events/subscriptions"))).toEqual({
      subscriptions: [],
    });
    expect((await api(owner, ownerKey, path)).status).toBe(200);

    // A job event published to one account reaches only that account's callback.
    expect([...events.hubs.keys()]).toEqual(["gh-1", "gh-2"]);
    const finished = jobEvents(
      { jobId: "00000000-0000-4000-8000-000000000001", command: "gemini generate" },
      { status: "failed", createdAt: 1, finishedAt: 2 },
    );
    const ownerHub = events.namespace.getByName("gh-1") as EventHub;
    await ownerHub.publish(finished);
    await ownerHub.alarm();
    expect(events.sent.map((s) => [s.account, s.url])).toEqual([
      ["gh-1", "https://owner.example.com/in"],
    ]);
  });

  it("rejects bad callbacks and answers 503 without the events binding", async () => {
    const events = fakeEventsNamespace();
    const { browser } = await signedInBrowser({ MULTIX_EVENTS: events.namespace });
    const key = await createApiKey(browser);
    for (const callback_url of [
      "http://hooks.example.com/in",
      "https://10.0.0.1/in",
      `${ORIGIN}/x`,
      "https://private.example.com/in",
    ]) {
      const bad = await api(browser, key, "/events/subscriptions", {
        method: "POST",
        body: JSON.stringify({ callback_url }),
      });
      expect(bad.status, callback_url).toBe(400);
    }
    const rebound = await api(browser, key, "/events/subscriptions", {
      method: "POST",
      body: JSON.stringify({ callback_url: "https://private.example.com/in" }),
    });
    expect(await body(rebound)).toEqual({
      error: {
        code: "bad_request",
        message: "callback_url resolves to a private or reserved address",
      },
    });
    const unresolved = await api(browser, key, "/events/subscriptions", {
      method: "POST",
      body: JSON.stringify({ callback_url: "https://dnsfail.example.com/in" }),
    });
    expect(unresolved.status).toBe(503);
    expect(unresolved.headers.get("retry-after")).toBe("30");
    expect(await body(unresolved)).toMatchObject({ error: { code: "unavailable" } });
    expect(await body(await api(browser, key, "/events/subscriptions"))).toEqual({
      subscriptions: [],
    });

    const bare = await signedInBrowser();
    const bareKey = await createApiKey(bare.browser);
    expect((await api(bare.browser, bareKey, "/events")).status).toBe(200);
    const unavailable = await api(bare.browser, bareKey, "/events/subscriptions");
    expect(unavailable.status).toBe(503);
    expect(await body(unavailable)).toMatchObject({ error: { code: "unavailable" } });
  });
});

describe("REST API documentation", () => {
  it("serves the OpenAPI document and the HTML reference without authentication", async () => {
    const { browser } = await signedInBrowser();
    const spec = await browser.request("/api/v1/openapi.json");
    expect(spec.status).toBe(200);
    const doc = await body(spec);
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe(`${ORIGIN}/api/v1`);
    const docs = await browser.request("/api/docs");
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await docs.text()).toContain("/api/v1/provider-keys");
  });

  it("documents only routes the router answers", async () => {
    const { browser } = await signedInBrowser();
    const key = await createApiKey(browser);
    const paths = openApiDocument(ORIGIN).paths as Record<string, Record<string, unknown>>;
    for (const [path, item] of Object.entries(paths)) {
      for (const method of ["get", "put", "patch", "post", "delete"]) {
        if (!item[method]) continue;
        const concrete = path
          .replace("{name}", "GEMINI_API_KEY")
          .replace("{id}", "00000000-0000-4000-8000-000000000000");
        const response = await api(browser, key, concrete, {
          method: method.toUpperCase(),
          body: ["put", "patch", "post"].includes(method) ? "{}" : undefined,
        });
        expect(response.status, `${method} ${path}`).not.toBe(405);
        // Only an unknown job or API key id may be "not found"; the route itself must exist.
        if (response.status === 404) expect(path, `${method} ${path}`).toContain("{id}");
      }
    }
  });
});

describe("REST API model catalogue", () => {
  it("compares offerings for one request and rejects bad parameters", async () => {
    const { browser } = await signedInBrowser();
    const key = await createApiKey(browser);
    const compare = await api(
      browser,
      key,
      "/model-catalog?view=compare&task=video&resolution=720p&duration_s=10&audio=true",
    );
    expect(compare.status).toBe(200);
    const rows = (await body(compare)).comparison.rows as Json[];
    const seedance = rows.find(
      (r) =>
        r.offering === "fal:bytedance/seedance-2.5/text-to-video" && r.price_rank !== undefined,
    );
    expect(seedance?.total_usd).toBeCloseTo(4.6224, 4);

    const models = await body(await api(browser, key, "/model-catalog?task=video&priced=true"));
    expect(models.offerings.length).toBeGreaterThan(0);
    expect((await api(browser, key, "/model-catalog?duration_s=abc&view=compare")).status).toBe(
      400,
    );
    expect((await api(browser, key, "/model-catalog?view=everything")).status).toBe(400);
    expect((await api(browser, key, "/model-catalog?view=compare&images=2.5")).status).toBe(400);
    expect((await api(browser, key, "/model-catalog?view=compare&duration_s=3601")).status).toBe(
      400,
    );
    expect((await api(browser, key, "/model-catalog?view=compare&duration_s=0")).status).toBe(400);
    expect((await api(browser, key, "/model-catalog?task=telepathy")).status).toBe(400);
    expect((await api(browser, undefined, "/model-catalog")).status).toBe(401);
  });
});
