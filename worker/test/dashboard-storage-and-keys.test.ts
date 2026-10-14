import { describe, expect, it } from "vitest";
import { AccountStore } from "../src/accounts/account-store.js";
import { bytesToBase64 } from "../src/accounts/base64.js";
import { importEncryptionKey } from "../src/accounts/provider-secret-crypto.js";
import type { WorkerEnv } from "../src/config.js";
import { HTML_SECURITY_HEADERS } from "../src/http-responses.js";
import { PROVIDER_KEY_GROUPS, PROVIDER_SECRET_NAMES } from "../src/provider-secret-names.js";
import { withoutCopyScript } from "./copy-script-helpers.js";
import { type RecordedCall, route } from "./helpers.js";
import { githubFetch, hiddenField, newBrowser, oauthEnv, signIn } from "./oauth-harness.js";

const OCTOCAT = { id: 583231, login: "octocat" };
const USER_ID = "gh-583231";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const ACCESS_KEY_ID = "AKIDEXAMPLE0123456789";
const SECRET = "r2-secret-access-key-0123456789abcdef";

type Responder = (call: RecordedCall) => Response;
const ok: Responder = () => new Response(null, { status: 200 });

/** Fake R2 endpoint for the bucket check; each step can be overridden. */
function r2Routes(list: Responder = ok, put: Responder = ok, del: Responder = ok) {
  return [
    route("GET", /^https:\/\/[0-9a-f]{32}\.r2\.cloudflarestorage\.com\/.*list-type=2/, list),
    route("PUT", /\.r2\.cloudflarestorage\.com\/my-bucket\/\.multix-probe-[0-9a-f-]+$/, put),
    route("DELETE", /\.r2\.cloudflarestorage\.com\/my-bucket\/\.multix-probe-[0-9a-f-]+$/, del),
  ];
}

async function signedIn(...extra: Parameters<typeof githubFetch>[1][]) {
  const env = oauthEnv();
  const github = githubFetch(OCTOCAT, ...extra);
  const browser = newBrowser(env, github.fetch);
  await signIn(browser);
  const csrf = hiddenField(await (await browser.request("/dashboard")).text(), "csrf");
  return { env, github, browser, csrf };
}

function store(env: WorkerEnv): AccountStore {
  return new AccountStore(env.ACCOUNTS_KV, importEncryptionKey(env.SECRETS_ENCRYPTION_KEY));
}

const kvDump = (env: WorkerEnv) =>
  JSON.stringify([...(env.ACCOUNTS_KV as unknown as { dump(): Map<string, unknown> }).dump()]);

const r2Form = (csrf: string, overrides: Record<string, string> = {}) => ({
  csrf,
  intent: "save",
  account_id: ACCOUNT_ID.toUpperCase(),
  access_key_id: ACCESS_KEY_ID,
  secret_access_key: SECRET,
  bucket: "my-bucket",
  public_base_url: "",
  ...overrides,
});

describe("dashboard provider keys", () => {
  it("offers an input for every key env name, grouped by provider with a link", async () => {
    const { browser } = await signedIn();
    const page = await (await browser.request("/dashboard")).text();
    for (const group of PROVIDER_KEY_GROUPS) {
      expect(page).toContain(`<strong>${group.provider}</strong>`);
      expect(page).toContain(`href="${group.link}"`);
    }
    for (const name of PROVIDER_SECRET_NAMES) {
      expect(page).toContain(`<input type="hidden" name="name" value="${name}">`);
    }
    expect(page).toContain("read only when BYTEPLUS_API_KEY is not set");
    expect(withoutCopyScript(page)).not.toMatch(/<script/i);
  });

  it("stores a CLI-only key encrypted and returns it with the account's provider keys", async () => {
    const { env, browser, csrf } = await signedIn();
    const value = "AIzaSy-gemini-key-value-0123456789";
    const saved = await browser.post("/dashboard/secrets", {
      csrf,
      name: "GEMINI_API_KEY",
      value,
      intent: "save",
    });
    expect(saved.headers.get("location")).toBe("/dashboard?notice=saved");
    expect(kvDump(env)).not.toContain(value);
    expect(await (await browser.request("/dashboard")).text()).not.toContain(value);
    expect(await store(env).providerKeys(USER_ID)).toEqual({ GEMINI_API_KEY: value });
  });
});

describe("dashboard R2 storage", () => {
  it("checks access, then saves the settings encrypted and never shows the key pair", async () => {
    const { env, github, browser, csrf } = await signedIn(...r2Routes());
    const response = await browser.post(
      "/dashboard/storage",
      r2Form(csrf, { public_base_url: "https://media.example.com/out/" }),
    );
    expect(response.headers.get("location")).toBe("/dashboard?notice=r2-saved");
    const r2Calls = github.calls.filter((c) => c.url.includes("r2.cloudflarestorage.com"));
    expect(r2Calls.map((c) => c.method)).toEqual(["GET", "PUT", "DELETE"]);
    expect(r2Calls[0]?.url).toBe(
      `https://${ACCOUNT_ID}.r2.cloudflarestorage.com/my-bucket?list-type=2&max-keys=1`,
    );

    expect(await store(env).r2Settings(USER_ID)).toEqual({
      accountId: ACCOUNT_ID,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET,
      bucket: "my-bucket",
      publicBaseUrl: "https://media.example.com/out",
    });
    const dump = kvDump(env);
    expect(dump).toContain(`r2:${USER_ID}`);
    for (const plain of [SECRET, ACCESS_KEY_ID, ACCOUNT_ID, "my-bucket"]) {
      expect(dump).not.toContain(plain);
    }

    const page = await (await browser.request("/dashboard?notice=r2-saved")).text();
    expect(page).toContain("R2 storage saved.");
    expect(page).toContain(`Bucket <span class="mono">my-bucket</span>`);
    expect(page).toContain("https://media.example.com/out");
    expect(page).not.toContain(SECRET);
    expect(page).not.toContain(ACCESS_KEY_ID);
  });

  it.each([
    [{ account_id: "not-hex" }, "r2-invalid-account"],
    [{ account_id: `${ACCOUNT_ID}.evil.example` }, "r2-invalid-account"],
    [{ access_key_id: "short" }, "r2-invalid-keys"],
    [{ secret_access_key: "has space in the secret value" }, "r2-invalid-keys"],
    [{ bucket: "My_Bucket" }, "r2-invalid-bucket"],
    [{ bucket: "my-bucket/../x" }, "r2-invalid-bucket"],
    [{ public_base_url: "http://media.example.com" }, "r2-invalid-url"],
    [{ public_base_url: "https://media.example.com/?token=1" }, "r2-invalid-url"],
    [{ public_base_url: "https://user:pw@media.example.com" }, "r2-invalid-url"],
  ])("rejects %j before calling R2", async (overrides, notice) => {
    const { env, github, browser, csrf } = await signedIn(...r2Routes());
    const response = await browser.post("/dashboard/storage", r2Form(csrf, overrides));
    expect(response.headers.get("location")).toBe(`/dashboard?notice=${notice}`);
    expect(github.calls.some((c) => c.url.includes("r2.cloudflarestorage.com"))).toBe(false);
    expect(await store(env).r2Settings(USER_ID)).toBeNull();
  });

  it.each([
    [
      "r2-denied",
      r2Routes(() => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })),
    ],
    [
      "r2-no-bucket",
      r2Routes(() => new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 })),
    ],
    ["r2-read-only", r2Routes(ok, () => new Response(null, { status: 403 }))],
    ["r2-no-delete", r2Routes(ok, ok, () => new Response(null, { status: 403 }))],
    [
      "r2-unreachable",
      r2Routes(() => {
        throw new TypeError(`connect failed ${SECRET}`);
      }),
    ],
  ])("saves nothing and shows %s when the check fails", async (notice, routes) => {
    const { env, browser, csrf } = await signedIn(...routes);
    const response = await browser.post("/dashboard/storage", r2Form(csrf));
    expect(response.headers.get("location")).toBe(`/dashboard?notice=${notice}`);
    expect(await store(env).r2Settings(USER_ID)).toBeNull();
    const page = await (await browser.request(`/dashboard?notice=${notice}`)).text();
    expect(page).toContain("R2 settings not saved");
    expect(page).not.toContain(SECRET);
  });

  it("removes the settings", async () => {
    const { env, browser, csrf } = await signedIn(...r2Routes());
    await browser.post("/dashboard/storage", r2Form(csrf));
    expect(await (await browser.request("/dashboard")).text()).toContain("Configured");
    const removed = await browser.post("/dashboard/storage", { csrf, intent: "delete" });
    expect(removed.headers.get("location")).toBe("/dashboard?notice=r2-removed");
    expect(await store(env).r2Settings(USER_ID)).toBeNull();
    expect(await (await browser.request("/dashboard")).text()).toContain("Not configured");
  });

  it("requires the CSRF token and a same-origin post", async () => {
    const { env, github, browser, csrf } = await signedIn(...r2Routes());
    const { csrf: _omit, ...withoutCsrf } = r2Form(csrf);
    expect((await browser.post("/dashboard/storage", withoutCsrf)).status).toBe(403);
    expect((await browser.post("/dashboard/storage", r2Form("forged"))).status).toBe(403);
    expect(
      (await browser.post("/dashboard/storage", r2Form(csrf), "https://evil.example")).status,
    ).toBe(403);
    expect(github.calls.some((c) => c.url.includes("r2.cloudflarestorage.com"))).toBe(false);
    expect(await store(env).r2Settings(USER_ID)).toBeNull();
  });

  it("treats settings that no longer decrypt as not configured", async () => {
    const { env, browser, csrf } = await signedIn(...r2Routes());
    await browser.post("/dashboard/storage", r2Form(csrf));
    const otherKey = importEncryptionKey(bytesToBase64(new Uint8Array(32).fill(9)));
    expect(await new AccountStore(env.ACCOUNTS_KV, otherKey).r2Settings(USER_ID)).toBeNull();
    expect(await store(env).r2Settings(USER_ID)).not.toBeNull();
  });

  it("treats a malformed settings record as not configured", async () => {
    const { env } = await signedIn();
    await env.ACCOUNTS_KV.put(`r2:${USER_ID}`, "{not json");
    expect(await store(env).r2Settings(USER_ID)).toBeNull();
  });

  it("keeps the dashboard CSP: only the hashed copy script, inline styles", async () => {
    const { browser } = await signedIn();
    const response = await browser.request("/dashboard");
    expect(response.headers.get("content-security-policy")).toBe(
      HTML_SECURITY_HEADERS["content-security-policy"],
    );
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(withoutCopyScript(await response.text())).not.toMatch(/<script|\son[a-z]+=/i);
  });
});
