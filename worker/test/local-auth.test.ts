import { afterEach, describe, expect, it, vi } from "vitest";
import { storeBootstrapTokenHash } from "../src/accounts/local-auth.js";
import type { WorkerEnv } from "../src/config.js";
import { mockFetch } from "./helpers.js";
import {
  type Browser,
  ORIGIN,
  authorizeAndGetToken,
  githubFetch,
  hiddenField,
  mcpCall,
  newBrowser,
  oauthEnv,
  registerClient,
} from "./oauth-harness.js";

const BOOTSTRAP_TOKEN = "bootstrap-token-0123456789abcdef-0123456789";
const PASSWORD = "correct horse battery staple";
const INVALID_LOGIN = "Incorrect username or password.";

/** Local sign-in on, no GitHub OAuth App. */
function localEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return oauthEnv({
    MULTIX_LOCAL_AUTH: "true",
    MULTIX_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    GITHUB_CLIENT_ID: undefined,
    GITHUB_CLIENT_SECRET: undefined,
    ...overrides,
  });
}

/** No outbound requests are expected: any fetch fails the test. */
function localBrowser(env: WorkerEnv): Browser {
  return newBrowser(env, mockFetch().fetch);
}

function kvDump(env: WorkerEnv): string {
  return JSON.stringify([
    ...(env.ACCOUNTS_KV as unknown as { dump(): Map<string, unknown> }).dump(),
  ]);
}

function kvGet(env: WorkerEnv, key: string): Promise<unknown> {
  return env.ACCOUNTS_KV.get(key, { type: "json" });
}

function setup(browser: Browser, fields: Record<string, string> = {}, origin = ORIGIN) {
  return browser.post(
    "/dashboard/setup",
    { token: BOOTSTRAP_TOKEN, username: "admin", password: PASSWORD, confirm: PASSWORD, ...fields },
    origin,
  );
}

function login(browser: Browser, fields: Record<string, string> = {}, origin = ORIGIN) {
  return browser.post(
    "/dashboard/login",
    { username: "admin", password: PASSWORD, return_to: "/dashboard", ...fields },
    origin,
  );
}

/** An env whose bootstrap admin `admin` exists, and a fresh signed-out browser. */
async function withAdmin(overrides: Partial<WorkerEnv> = {}) {
  const env = localEnv(overrides);
  const first = await setup(localBrowser(env));
  expect(first.status).toBe(303);
  return { env, browser: localBrowser(env) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it("keeps today's behaviour with local auth off: no setup page, login goes to GitHub", async () => {
    const browser = newBrowser(oauthEnv(), githubFetch({ id: 1, login: "octocat" }).fetch);
    expect((await browser.request("/dashboard/setup")).status).toBe(404);
    const start = await browser.request("/dashboard/login");
    expect(start.status).toBe(302);
    expect(new URL(start.headers.get("location") ?? "").origin).toBe("https://github.com");
  });

  it("still answers 503 without GitHub secrets when local auth is off", async () => {
    for (const value of [undefined, "false", "1", "yes"]) {
      const env = localEnv({ MULTIX_LOCAL_AUTH: value });
      const browser = localBrowser(env);
      expect((await browser.request("/dashboard")).status).toBe(503);
      expect((await browser.request("/dashboard/login")).status).toBe(503);
    }
  });

  it("runs without GitHub secrets when local auth is on", async () => {
    const browser = localBrowser(localEnv());
    const landing = await browser.request("/dashboard");
    expect(landing.status).toBe(200);
    const page = await landing.text();
    expect(page).toContain('action="/dashboard/login"');
    expect(page).toContain('href="/dashboard/setup"');
    expect(page).not.toContain("/dashboard/login/github");

    const form = await browser.request("/dashboard/login");
    expect(form.status).toBe(200);
    expect((await browser.request("/dashboard/login/github")).status).toBe(404);
    expect((await browser.request("/oauth/github/callback?code=x&state=y")).status).toBe(404);
  });

  it("offers GitHub next to local sign-in when both are configured", async () => {
    const env = localEnv({ GITHUB_CLIENT_ID: "gh-client-id", GITHUB_CLIENT_SECRET: "gh-secret" });
    const browser = newBrowser(env, githubFetch({ id: 1, login: "octocat" }).fetch);
    const page = await (
      await browser.request("/dashboard/login?return_to=%2Foauth%2Fauthorize%3Fa%3D1")
    ).text();
    expect(page).toContain('href="/dashboard/login/github?return_to=%2Foauth%2Fauthorize%3Fa%3D1"');
    const start = await browser.request("/dashboard/login/github?return_to=%2Fdashboard");
    expect(start.status).toBe(302);
    expect(new URL(start.headers.get("location") ?? "").origin).toBe("https://github.com");
  });
});

describe("bootstrap setup", () => {
  it("shows the setup form while no admin exists", async () => {
    const response = await localBrowser(localEnv()).request("/dashboard/setup");
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('name="token"');
    expect(page).toContain('name="confirm"');
    expect(page).not.toContain(BOOTSTRAP_TOKEN);
  });

  it("rejects a wrong or missing token and stores nothing", async () => {
    const env = localEnv();
    const browser = localBrowser(env);
    for (const token of ["wrong-token-wrong-token-wrong-token-0000", ""]) {
      const response = await setup(browser, { token });
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("The bootstrap token is not valid.");
    }
    expect(kvDump(env)).not.toContain("local-");
    expect(browser.cookies.size).toBe(0);
  });

  it("ignores a MULTIX_BOOTSTRAP_TOKEN shorter than 32 characters", async () => {
    const short = "short-token-123";
    const browser = localBrowser(localEnv({ MULTIX_BOOTSTRAP_TOKEN: short }));
    expect((await setup(browser, { token: short })).status).toBe(403);
  });

  it("rejects a cross-origin POST", async () => {
    const env = localEnv();
    const response = await setup(localBrowser(env), {}, "https://evil.example");
    expect(response.status).toBe(403);
    expect(await kvGet(env, "local-setup")).toBeNull();
  });

  it("rejects a weak password, a mismatch and an invalid username", async () => {
    const env = localEnv();
    const browser = localBrowser(env);
    const weak = await setup(browser, { password: "short", confirm: "short" });
    expect(weak.status).toBe(400);
    expect(await weak.text()).toContain("12–256 characters");
    const mismatch = await setup(browser, { confirm: `${PASSWORD}!` });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.text()).toContain("do not match");
    for (const username of ["ab", "-admin", "ad min", "a".repeat(33), "admin:x"]) {
      expect((await setup(browser, { username })).status).toBe(400);
    }
    expect(await kvGet(env, "local-setup")).toBeNull();
  });

  it("creates the admin, signs it in and closes setup for good", async () => {
    const env = localEnv();
    const browser = localBrowser(env);
    const log = vi.spyOn(console, "log");
    const response = await setup(browser, { username: "Admin" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/dashboard");

    const dashboard = await browser.request("/dashboard");
    expect(dashboard.status).toBe(200);
    const page = await dashboard.text();
    expect(page).toContain("admin");
    expect(page).toContain('name="csrf"');

    const marker = (await kvGet(env, "local-setup")) as { accountId: string };
    expect(marker.accountId).toMatch(/^local-[A-Za-z0-9_-]+$/);
    const credential = (await kvGet(env, "local-user:admin")) as Record<string, unknown>;
    expect(credential).toMatchObject({ accountId: marker.accountId, iterations: 100000 });
    expect(await kvGet(env, `account:${marker.accountId}`)).toMatchObject({
      login: "admin",
      emails: [],
      githubId: 0,
    });
    expect(kvDump(env)).not.toContain(PASSWORD);
    expect(kvDump(env)).not.toContain(BOOTSTRAP_TOKEN);
    expect(log.mock.calls.flat().join("\n")).toContain("bootstrap_admin_created");

    expect((await browser.request("/dashboard/setup")).status).toBe(404);
    const again = await setup(localBrowser(env), { username: "second" });
    expect(again.status).toBe(404);
    expect(await kvGet(env, "local-user:second")).toBeNull();
  });

  it("accepts the token whose hash the server stored, then deletes the hash", async () => {
    const env = localEnv({ MULTIX_BOOTSTRAP_TOKEN: undefined });
    const generated = "generated-at-boot-0123456789abcdef0123456789";
    await storeBootstrapTokenHash(env.ACCOUNTS_KV, generated);
    expect(kvDump(env)).not.toContain(generated);
    const browser = localBrowser(env);
    expect((await setup(browser, { token: "not-the-generated-token-0123456789" })).status).toBe(
      403,
    );
    expect((await setup(browser, { token: generated })).status).toBe(303);
    expect(await kvGet(env, "local-setup-token")).toBeNull();
  });

  it("refuses to store a short bootstrap token", async () => {
    await expect(storeBootstrapTokenHash(localEnv().ACCOUNTS_KV, "too-short")).rejects.toThrow();
  });
});

describe("local sign-in", () => {
  it("signs in with the right password and returns to a safe path", async () => {
    const { browser } = await withAdmin();
    const page = await (await browser.request("/dashboard/login")).text();
    expect(page).not.toContain('href="/dashboard/setup"');
    const response = await login(browser, { username: " ADMIN " });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/dashboard");
    expect(await (await browser.request("/dashboard")).text()).toContain('name="csrf"');

    const elsewhere = await login(browser, { return_to: "https://evil.example/" });
    expect(elsewhere.headers.get("location")).toBe("/dashboard");
    const consent = await login(browser, { return_to: "/oauth/authorize?client_id=x" });
    expect(consent.headers.get("location")).toBe("/oauth/authorize?client_id=x");
  });

  it("gives the same generic error for a wrong password and an unknown user", async () => {
    const { browser } = await withAdmin();
    const warn = vi.spyOn(console, "warn");
    const wrong = await login(browser, { password: "not the right password" });
    const unknown = await login(browser, { username: "nobody", password: PASSWORD });
    const invalid = await login(browser, { username: "x", password: "" });
    for (const response of [wrong, unknown, invalid]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie") ?? "").not.toContain("multix-session");
      expect(await response.text()).toContain(INVALID_LOGIN);
    }
    expect(browser.cookies.size).toBe(0);
    const logged = warn.mock.calls.flat().join("\n");
    expect(logged).toContain("local_sign_in_failed");
    expect(logged).not.toContain("nobody");
    expect(logged).not.toContain(PASSWORD);
  });

  it("rejects a cross-origin sign-in", async () => {
    const { browser } = await withAdmin();
    expect((await login(browser, {}, "https://evil.example")).status).toBe(403);
    expect(browser.cookies.size).toBe(0);
  });

  it("locks the account out when local auth is turned off or its credential is removed", async () => {
    const { env, browser } = await withAdmin();
    await login(browser);
    const clientId = await registerClient(browser);
    const token = await authorizeAndGetToken(browser, clientId);
    expect((await mcpCall(browser, token, "tools/list")).status).toBe(200);

    Object.assign(env, {
      MULTIX_LOCAL_AUTH: "false",
      GITHUB_CLIENT_ID: "gh-client-id",
      GITHUB_CLIENT_SECRET: "gh-secret",
    });
    expect((await mcpCall(browser, token, "tools/list")).status).toBe(403);
    expect(await (await browser.request("/dashboard")).text()).not.toContain('name="csrf"');

    const fresh = await withAdmin();
    await login(fresh.browser);
    expect(await (await fresh.browser.request("/dashboard")).text()).toContain('name="csrf"');
    await fresh.env.ACCOUNTS_KV.delete("local-user:admin");
    expect(await (await fresh.browser.request("/dashboard")).text()).not.toContain('name="csrf"');
  });
});

describe("MCP consent with a local account and no GitHub secrets", () => {
  it("sends the browser through local sign-in and back to the consent page", async () => {
    const { browser } = await withAdmin();
    const clientId = await registerClient(browser);
    const authorize = `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("http://localhost:3333/callback")}&code_challenge=abcdefghijabcdefghijabcdefghijabcdefghij123&code_challenge_method=S256&state=s`;
    const start = await browser.request(authorize);
    expect(start.status).toBe(302);
    const loginPath = start.headers.get("location") ?? "";
    expect(loginPath.startsWith("/dashboard/login?return_to=%2Foauth%2Fauthorize%3F")).toBe(true);

    const form = await browser.request(loginPath);
    expect(form.status).toBe(200);
    const returnTo = hiddenField(await form.text(), "return_to");
    expect(returnTo).toBe(authorize);
    const signedIn = await login(browser, { return_to: returnTo });
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get("location")).toBe(authorize);

    const consent = await browser.request(authorize);
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain("admin");

    const token = await authorizeAndGetToken(browser, clientId);
    const tools = await mcpCall(browser, token, "tools/list");
    expect(tools.status).toBe(200);
  });
});
