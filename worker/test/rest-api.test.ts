import { describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/accounts/api-key-store.js";
import { openApiDocument } from "../src/api/openapi-document.js";
import { fakeNamespace, fakeQuotaNamespace } from "./fake-job-bindings.js";
import { fakeKv } from "./fake-kv.js";
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
  const browser = newBrowser(env, githubFetch(OCTOCAT).fetch);
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
    const owner = newBrowser(env, githubFetch(OCTOCAT).fetch);
    await signIn(owner);
    const ownerKey = await createApiKey(owner);
    const job = await body(
      await api(owner, ownerKey, "/jobs", {
        method: "POST",
        body: JSON.stringify({ command: "gemini generate", options: { prompt: "p" } }),
      }),
    );

    const other = newBrowser(env, githubFetch({ id: 2, login: "hubot" }).fetch);
    await signIn(other);
    const otherKey = await createApiKey(other);
    expect((await api(other, otherKey, `/jobs/${job.job_id}`)).status).toBe(404);
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
