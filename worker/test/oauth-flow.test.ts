import { afterEach, describe, expect, it, vi } from "vitest";
import { sign } from "../src/auth/signed-cookies.js";
import { jsonResponse, route } from "./helpers.js";
import {
  GITHUB_SECRET,
  ORIGIN,
  SESSION_SECRET,
  authorizeAndGetToken,
  githubFetch,
  hiddenField,
  mcpCall,
  newBrowser,
  oauthEnv,
  registerClient,
  signIn,
} from "./oauth-harness.js";

const OCTOCAT = { id: 583231, login: "octocat" };
const SAVED_KEY = "r8_saved_by_dashboard_0123456789";

// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC payloads are untyped in tests
async function toolResult(response: Response): Promise<any> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result: unknown };
  return body.result;
}

describe("MCP discovery", () => {
  it("answers an unauthenticated /mcp with a challenge pointing at the resource metadata", async () => {
    const browser = newBrowser(oauthEnv(), githubFetch(OCTOCAT).fetch);
    const response = await mcpCall(browser, undefined, "tools/list");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );

    const prm = await browser.request("/.well-known/oauth-protected-resource/mcp");
    expect(await prm.json()).toMatchObject({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
    });
    const as = (await (
      await browser.request("/.well-known/oauth-authorization-server")
    ).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
    });
  });

  it("rejects an invalid bearer token", async () => {
    const browser = newBrowser(oauthEnv(), githubFetch(OCTOCAT).fetch);
    const response = await mcpCall(browser, "user:grant:not-a-real-token", "tools/list");
    expect(response.status).toBe(401);
  });
});

describe("authorize, consent and per-account keys", () => {
  it("runs tools with the keys of the account that approved the client", async () => {
    const env = oauthEnv();
    const github = githubFetch(
      OCTOCAT,
      route("GET", /^https:\/\/api\.replicate\.com\/v1\/predictions\/abc123$/, () =>
        jsonResponse({
          id: "abc123",
          status: "succeeded",
          output: ["https://replicate.delivery/x.png"],
        }),
      ),
    );
    const browser = newBrowser(env, github.fetch);
    const clientId = await registerClient(browser);
    const token = await authorizeAndGetToken(browser, clientId);

    // GitHub was called with PKCE and the client secret, then forgotten.
    const exchange = github.calls.find((c) => c.url.includes("access_token"));
    expect(exchange?.method).toBe("POST");
    expect(
      JSON.stringify([...(env.ACCOUNTS_KV as unknown as { dump(): Map<string, unknown> }).dump()]),
    ).not.toContain("gho_fake");

    let list = await toolResult(
      await mcpCall(browser, token, "tools/call", { name: "multix_list_providers", arguments: {} }),
    );
    const replicate = () =>
      list.structuredContent.providers.find((p: { id: string }) => p.id === "replicate");
    expect(replicate().configured).toBe(false);

    // Save a key from the dashboard.
    const dashboard = await (await browser.request("/dashboard")).text();
    expect(dashboard).toContain("octocat");
    expect(dashboard).toContain("Test Client");
    const csrf = hiddenField(dashboard, "csrf");
    const saved = await browser.post("/dashboard/secrets", {
      csrf,
      name: "REPLICATE_API_TOKEN",
      value: SAVED_KEY,
      intent: "save",
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/dashboard?notice=saved");

    // Encrypted at rest, never shown back.
    const stored = JSON.stringify([
      ...(env.ACCOUNTS_KV as unknown as { dump(): Map<string, unknown> }).dump(),
    ]);
    expect(stored).toContain("REPLICATE_API_TOKEN");
    expect(stored).not.toContain(SAVED_KEY);
    expect(await (await browser.request("/dashboard")).text()).not.toContain(SAVED_KEY);

    list = await toolResult(
      await mcpCall(browser, token, "tools/call", { name: "multix_list_providers", arguments: {} }),
    );
    expect(replicate().configured).toBe(true);

    const status = await toolResult(
      await mcpCall(browser, token, "tools/call", {
        name: "multix_prediction_status",
        arguments: { provider: "replicate", prediction_id: "abc123" },
      }),
    );
    expect(status.structuredContent).toMatchObject({ status: "succeeded", done: true });
    const providerCall = github.calls.find((c) => c.url.includes("api.replicate.com"));
    expect(providerCall?.headers.authorization).toBe(`Bearer ${SAVED_KEY}`);
  });

  it("does not let one account use another account's keys", async () => {
    const env = oauthEnv({ MULTIX_ALLOWED_USERS: "octocat,hubot" });
    const owner = newBrowser(env, githubFetch(OCTOCAT).fetch);
    await signIn(owner);
    const csrf = hiddenField(await (await owner.request("/dashboard")).text(), "csrf");
    await owner.post("/dashboard/secrets", {
      csrf,
      name: "REPLICATE_API_TOKEN",
      value: SAVED_KEY,
      intent: "save",
    });

    const other = newBrowser(env, githubFetch({ id: 2, login: "hubot" }).fetch);
    const token = await authorizeAndGetToken(other, await registerClient(other));
    const list = await toolResult(
      await mcpCall(other, token, "tools/call", { name: "multix_list_providers", arguments: {} }),
    );
    const replicate = list.structuredContent.providers.find(
      (p: { id: string }) => p.id === "replicate",
    );
    expect(replicate.configured).toBe(false);
  });

  it("ignores provider keys set as Worker secrets by the operator", async () => {
    const env = oauthEnv();
    Object.assign(env, { REPLICATE_API_TOKEN: "r8_operator_key_should_not_be_used" });
    const browser = newBrowser(env, githubFetch(OCTOCAT).fetch);
    const token = await authorizeAndGetToken(browser, await registerClient(browser));
    const list = await toolResult(
      await mcpCall(browser, token, "tools/call", { name: "multix_list_providers", arguments: {} }),
    );
    const replicate = list.structuredContent.providers.find(
      (p: { id: string }) => p.id === "replicate",
    );
    expect(replicate.configured).toBe(false);
  });

  it("sends a signed-out browser through GitHub sign-in and back to the consent page", async () => {
    const browser = newBrowser(oauthEnv(), githubFetch(OCTOCAT).fetch);
    const clientId = await registerClient(browser);
    const response = await browser.request(
      `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("http://localhost:3333/callback")}&code_challenge=abcdefghijabcdefghijabcdefghijabcdefghij123&code_challenge_method=S256&state=s`,
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("/dashboard/login?return_to=%2Foauth%2Fauthorize%3F")).toBe(true);
    const callback = await signIn(browser, location);
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")?.startsWith("/oauth/authorize?")).toBe(true);
  });

  it("returns access_denied to the client when the user clicks Deny", async () => {
    const browser = newBrowser(oauthEnv(), githubFetch(OCTOCAT).fetch);
    await signIn(browser);
    const clientId = await registerClient(browser);
    const path = `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("http://localhost:3333/callback")}&code_challenge=abcdefghijabcdefghijabcdefghijabcdefghij123&code_challenge_method=S256&state=s`;
    const page = await (await browser.request(path)).text();
    expect(page).toContain("Test Client");
    expect(page).toContain("localhost");
    const denied = await browser.post(path, {
      handle: hiddenField(page, "handle"),
      decision: "deny",
    });
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "access_denied",
    );
  });

  it("escapes a hostile client name on the consent page", async () => {
    const browser = newBrowser(oauthEnv(), githubFetch(OCTOCAT).fetch);
    await signIn(browser);
    const clientId = await registerClient(browser, "<script>alert(1)</script>");
    const page = await (
      await browser.request(
        `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("http://localhost:3333/callback")}&code_challenge=abcdefghijabcdefghijabcdefghijabcdefghij123&code_challenge_method=S256&state=s`,
      )
    ).text();
    expect(page).not.toContain("<script>");
  });
});

describe("allowlist", () => {
  it("refuses sign-in for accounts that are not listed and stores nothing", async () => {
    const env = oauthEnv();
    const browser = newBrowser(env, githubFetch({ id: 9, login: "stranger" }).fetch);
    const response = await signIn(browser);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("not on this server");
    expect([
      ...(env.ACCOUNTS_KV as unknown as { dump(): Map<string, unknown> }).dump().keys(),
    ]).toEqual([]);
    expect(browser.cookies.has("__Host-multix-session")).toBe(false);
  });

  it("accepts a verified email entry but not an unverified one", async () => {
    const env = oauthEnv({ MULTIX_ALLOWED_USERS: "dev@example.com" });
    const verified = newBrowser(
      env,
      githubFetch({ id: 3, login: "dev", emails: [{ email: "Dev@Example.com", verified: true }] })
        .fetch,
    );
    expect((await signIn(verified)).status).toBe(303);
    const unverified = newBrowser(
      env,
      githubFetch({ id: 4, login: "dev2", emails: [{ email: "dev@example.com", verified: false }] })
        .fetch,
    );
    expect((await signIn(unverified)).status).toBe(403);
  });

  it("cuts off /mcp and the dashboard when an account is removed from the list", async () => {
    const env = oauthEnv();
    const browser = newBrowser(env, githubFetch(OCTOCAT).fetch);
    const token = await authorizeAndGetToken(browser, await registerClient(browser));
    env.MULTIX_ALLOWED_USERS = "someone-else";
    expect((await mcpCall(browser, token, "tools/list")).status).toBe(403);
    expect(await (await browser.request("/dashboard")).text()).toContain("Sign in with GitHub");
  });
});

describe("dashboard protections", () => {
  async function signedIn() {
    const env = oauthEnv();
    const browser = newBrowser(env, githubFetch(OCTOCAT).fetch);
    await signIn(browser);
    const csrf = hiddenField(await (await browser.request("/dashboard")).text(), "csrf");
    return { env, browser, csrf };
  }

  it("rejects posts without the CSRF token or from another origin", async () => {
    const { browser, csrf } = await signedIn();
    const fields = { name: "HEYGEN_API_KEY", value: "hg_key_123456", intent: "save" };
    expect((await browser.post("/dashboard/secrets", fields)).status).toBe(403);
    expect((await browser.post("/dashboard/secrets", { ...fields, csrf: "forged" })).status).toBe(
      403,
    );
    expect(
      (await browser.post("/dashboard/secrets", { ...fields, csrf }, "https://evil.example"))
        .status,
    ).toBe(403);
    expect((await browser.post("/dashboard/secrets", { ...fields, csrf })).status).toBe(303);
  });

  it("rejects unknown key names and malformed values", async () => {
    const { browser, csrf } = await signedIn();
    expect(
      (
        await browser.post("/dashboard/secrets", {
          csrf,
          name: "MCP_AUTH_TOKEN",
          value: "x",
          intent: "save",
        })
      ).status,
    ).toBe(400);
    const bad = await browser.post("/dashboard/secrets", {
      csrf,
      name: "HEYGEN_API_KEY",
      value: "has space",
      intent: "save",
    });
    expect(bad.headers.get("location")).toBe("/dashboard?notice=invalid");
  });

  it("removes a key", async () => {
    const { browser, csrf } = await signedIn();
    await browser.post("/dashboard/secrets", {
      csrf,
      name: "HEYGEN_API_KEY",
      value: "hg_key_123456",
      intent: "save",
    });
    expect(await (await browser.request("/dashboard")).text()).toContain(
      `<span class="badge ok">Saved`,
    );
    await browser.post("/dashboard/secrets", { csrf, name: "HEYGEN_API_KEY", intent: "delete" });
    expect(await (await browser.request("/dashboard")).text()).not.toContain(
      `<span class="badge ok">Saved`,
    );
  });

  it("disconnects an MCP client by revoking its grant", async () => {
    const env = oauthEnv();
    const browser = newBrowser(env, githubFetch(OCTOCAT).fetch);
    const token = await authorizeAndGetToken(browser, await registerClient(browser));
    const page = await (await browser.request("/dashboard")).text();
    const revoked = await browser.post("/dashboard/connections/revoke", {
      csrf: hiddenField(page, "csrf"),
      grant_id: hiddenField(page, "grant_id"),
    });
    expect(revoked.status).toBe(303);
    expect((await mcpCall(browser, token, "tools/list")).status).toBe(401);
  });

  it("signs out", async () => {
    const { browser, csrf } = await signedIn();
    await browser.post("/dashboard/logout", { csrf });
    expect(browser.cookies.has("__Host-multix-session")).toBe(false);
    expect(await (await browser.request("/dashboard")).text()).toContain("Sign in with GitHub");
  });

  it("rejects a GitHub callback whose state does not match the browser", async () => {
    const browser = newBrowser(oauthEnv(), githubFetch(OCTOCAT).fetch);
    await browser.request("/dashboard/login");
    const response = await browser.request("/oauth/github/callback?code=x&state=attacker-state");
    expect(response.status).toBe(400);
  });

  it("only returns to pages we own after sign-in", async () => {
    const browser = newBrowser(oauthEnv(), githubFetch(OCTOCAT).fetch);
    const callback = await signIn(
      browser,
      "/dashboard/login?return_to=https%3A%2F%2Fevil.example%2F",
    );
    expect(callback.headers.get("location")).toBe("/dashboard");
  });
});

describe("configuration", () => {
  it("serves /health without any configuration", async () => {
    const browser = newBrowser({} as never, githubFetch(OCTOCAT).fetch);
    const response = await browser.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("fails closed with 503 when a Worker secret is missing or weak", async () => {
    for (const overrides of [
      { SESSION_SECRET: "short" },
      { GITHUB_CLIENT_SECRET: "" },
      { SECRETS_ENCRYPTION_KEY: "bm90LTMyLWJ5dGVz" },
      { MULTIX_PUBLIC_URL: "http://multix.example.com" },
    ]) {
      const browser = newBrowser(oauthEnv(overrides), githubFetch(OCTOCAT).fetch);
      expect((await browser.request("/dashboard")).status).toBe(503);
    }
  });

  it("never puts the GitHub client secret or session secret in a page", async () => {
    const browser = newBrowser(oauthEnv(), githubFetch(OCTOCAT).fetch);
    await signIn(browser);
    const page = await (await browser.request("/dashboard")).text();
    expect(page).not.toContain(GITHUB_SECRET);
    expect(page).not.toContain(SESSION_SECRET);
  });
});

describe("hardening", () => {
  const accountsKv = (env: ReturnType<typeof oauthEnv>) =>
    env.ACCOUNTS_KV as unknown as KVNamespace;
  const providerConfigured = async (browser: ReturnType<typeof newBrowser>, token: string) => {
    const list = await toolResult(
      await mcpCall(browser, token, "tools/call", { name: "multix_list_providers", arguments: {} }),
    );
    return Object.fromEntries(
      list.structuredContent.providers.map((p: { id: string; configured: boolean }) => [
        p.id,
        p.configured,
      ]),
    );
  };

  it("sends a same-origin referrer policy so browsers keep the Origin header on form posts", async () => {
    const browser = newBrowser(oauthEnv(), githubFetch(OCTOCAT).fetch);
    // `no-referrer` makes browsers send `Origin: null`, which the same-origin check rejects.
    expect((await browser.request("/dashboard")).headers.get("referrer-policy")).toBe(
      "same-origin",
    );
  });

  it("keeps saved keys apart from the profile, so a later sign-in cannot drop them", async () => {
    const env = oauthEnv();
    const browser = newBrowser(env, githubFetch(OCTOCAT).fetch);
    const token = await authorizeAndGetToken(browser, await registerClient(browser));
    const csrf = hiddenField(await (await browser.request("/dashboard")).text(), "csrf");
    await browser.post("/dashboard/secrets", {
      csrf,
      name: "REPLICATE_API_TOKEN",
      value: SAVED_KEY,
      intent: "save",
    });
    await signIn(browser);

    const profile = await accountsKv(env).get(`account:gh-${OCTOCAT.id}`, "text");
    expect(profile).not.toContain("REPLICATE_API_TOKEN");
    expect(await accountsKv(env).get(`secrets:gh-${OCTOCAT.id}`, "text")).toContain(
      "REPLICATE_API_TOKEN",
    );
    expect((await providerConfigured(browser, token)).replicate).toBe(true);
  });

  it("treats a key that no longer decrypts as not set and keeps the other providers working", async () => {
    const env = oauthEnv();
    const browser = newBrowser(env, githubFetch(OCTOCAT).fetch);
    const token = await authorizeAndGetToken(browser, await registerClient(browser));
    const csrf = hiddenField(await (await browser.request("/dashboard")).text(), "csrf");
    for (const [name, value] of [
      ["REPLICATE_API_TOKEN", SAVED_KEY],
      ["HEYGEN_API_KEY", "hg_saved_by_dashboard_0123"],
    ] as const) {
      await browser.post("/dashboard/secrets", { csrf, name, value, intent: "save" });
    }
    // A record moved to another key name fails authentication (the name is bound in).
    const key = `secrets:gh-${OCTOCAT.id}`;
    const secrets = (await accountsKv(env).get(key, "json")) as Record<string, unknown>;
    secrets.REPLICATE_API_TOKEN = secrets.HEYGEN_API_KEY;
    await accountsKv(env).put(key, JSON.stringify(secrets));

    const configured = await providerConfigured(browser, token);
    expect(configured.replicate).toBe(false);
    expect(configured.heygen).toBe(true);
  });

  it("rejects a consent decision posted from another origin", async () => {
    const browser = newBrowser(oauthEnv(), githubFetch(OCTOCAT).fetch);
    await signIn(browser);
    const clientId = await registerClient(browser);
    const authorizePath = `/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://localhost:3333/callback",
      scope: "mcp",
      state: "s",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    })}`;
    const handle = hiddenField(await (await browser.request(authorizePath)).text(), "handle");
    const forged = await browser.post(
      authorizePath,
      { handle, decision: "approve" },
      "https://evil.example",
    );
    expect(forged.status).toBe(403);
  });

  it("does not let one account disconnect another account's client", async () => {
    const env = oauthEnv({ MULTIX_ALLOWED_USERS: "octocat,hubot" });
    const owner = newBrowser(env, githubFetch(OCTOCAT).fetch);
    const token = await authorizeAndGetToken(owner, await registerClient(owner));
    const grantId = hiddenField(await (await owner.request("/dashboard")).text(), "grant_id");

    const other = newBrowser(env, githubFetch({ id: 2, login: "hubot" }).fetch);
    await signIn(other);
    const csrf = hiddenField(await (await other.request("/dashboard")).text(), "csrf");
    await other.post("/dashboard/connections/revoke", { csrf, grant_id: grantId });
    expect((await mcpCall(owner, token, "tools/list")).status).toBe(200);
  });
});

describe("server-side sign-out", () => {
  // Sessions are ordered by millisecond timestamps, so these tests drive the
  // clock: a session issued in the sign-out's millisecond counts as signed out.
  const freezeClock = () => vi.useFakeTimers({ toFake: ["Date"], now: 1_800_000_000_000 });
  const tick = () => vi.setSystemTime(Date.now() + 1);
  afterEach(() => vi.useRealTimers());

  it("ends every dashboard session of the account, including copied cookies", async () => {
    freezeClock();
    const env = oauthEnv();
    const browser = newBrowser(env, githubFetch(OCTOCAT).fetch);
    const token = await authorizeAndGetToken(browser, await registerClient(browser));
    const oldCsrf = hiddenField(await (await browser.request("/dashboard")).text(), "csrf");
    // A second device (or a stolen cookie) holding the same session.
    const copy = newBrowser(env, githubFetch(OCTOCAT).fetch);
    for (const [name, value] of browser.cookies) copy.cookies.set(name, value);
    expect(await (await copy.request("/dashboard")).text()).toContain("Connected MCP clients");

    await browser.post("/dashboard/logout", { csrf: oldCsrf });
    expect(await (await copy.request("/dashboard")).text()).toContain("Sign in with GitHub");

    // Signing in again issues a new session; forms from before the sign-out are rejected.
    tick();
    await signIn(browser);
    const saved = await browser.post("/dashboard/secrets", {
      csrf: oldCsrf,
      name: "HEYGEN_API_KEY",
      value: "hg_key_123456",
      intent: "save",
    });
    expect(saved.status).toBe(403);
    // The new sign-in never rewrites the sign-out time, so old cookies stay void.
    expect(await (await copy.request("/dashboard")).text()).toContain("Sign in with GitHub");
    expect(await (await browser.request("/dashboard")).text()).toContain("Connected MCP clients");
    // MCP connections are grants, not dashboard sessions: they keep working.
    expect((await mcpCall(browser, token, "tools/list")).status).toBe(200);
  });

  it("binds the CSRF token to one session", async () => {
    freezeClock();
    const env = oauthEnv();
    const laptop = newBrowser(env, githubFetch(OCTOCAT).fetch);
    const phone = newBrowser(env, githubFetch(OCTOCAT).fetch);
    await signIn(laptop);
    tick();
    await signIn(phone);
    const laptopCsrf = hiddenField(await (await laptop.request("/dashboard")).text(), "csrf");
    const fields = { name: "HEYGEN_API_KEY", value: "hg_key_123456", intent: "save" };
    expect((await phone.post("/dashboard/secrets", { ...fields, csrf: laptopCsrf })).status).toBe(
      403,
    );
    expect((await laptop.post("/dashboard/secrets", { ...fields, csrf: laptopCsrf })).status).toBe(
      303,
    );
  });

  it("rejects a signed session cookie that has no issue time", async () => {
    const env = oauthEnv();
    const browser = newBrowser(env, githubFetch(OCTOCAT).fetch);
    await signIn(browser);
    const legacy = await sign(SESSION_SECRET, "session", { userId: `gh-${OCTOCAT.id}` }, 3600);
    browser.cookies.set("__Host-multix-session", legacy);
    expect(await (await browser.request("/dashboard")).text()).toContain("Sign in with GitHub");
  });
});
