/**
 * Harness for driving the whole Worker (OAuth provider + dashboard + /mcp) in
 * Node: in-memory KV, a cookie jar, a fake GitHub and helpers that walk an MCP
 * client through registration, sign-in, consent and token exchange.
 */

import { bytesToBase64, bytesToBase64Url } from "../src/accounts/base64.js";
import type { WorkerEnv } from "../src/config.js";
import { createWorker } from "../src/index.js";
import { fakeKv } from "./fake-kv.js";
import { type RecordedCall, jsonResponse, mockFetch, route } from "./helpers.js";

export const ORIGIN = "https://mcp.example.com";
export const REDIRECT_URI = "http://localhost:3333/callback";
export const SESSION_SECRET = "session-secret-0123456789abcdef0123456789";
export const GITHUB_SECRET = "github-client-secret-value-123";

export interface GithubUserFixture {
  id: number;
  login: string;
  emails?: { email: string; verified: boolean }[];
}

export function oauthEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    OAUTH_KV: fakeKv(),
    ACCOUNTS_KV: fakeKv(),
    MULTIX_PUBLIC_URL: ORIGIN,
    MULTIX_ALLOWED_USERS: "octocat",
    GITHUB_CLIENT_ID: "gh-client-id",
    GITHUB_CLIENT_SECRET: GITHUB_SECRET,
    SESSION_SECRET,
    SECRETS_ENCRYPTION_KEY: bytesToBase64(new Uint8Array(32).fill(7)),
    ...overrides,
  };
}

/** Fake GitHub (token, /user, /user/emails) plus any extra provider routes. */
export function githubFetch(
  user: GithubUserFixture,
  ...extra: ((call: RecordedCall) => Response | undefined)[]
) {
  return mockFetch(
    route("POST", /^https:\/\/github\.com\/login\/oauth\/access_token$/, () =>
      jsonResponse({ access_token: "gho_fake", token_type: "bearer" }),
    ),
    route("GET", /^https:\/\/api\.github\.com\/user$/, () =>
      jsonResponse({ id: user.id, login: user.login, name: "The Octocat" }),
    ),
    route("GET", /^https:\/\/api\.github\.com\/user\/emails$/, () =>
      jsonResponse(user.emails ?? [{ email: `${user.login}@example.com`, verified: true }]),
    ),
    ...extra,
  );
}

const execCtx = (): ExecutionContext =>
  ({ waitUntil() {}, passThroughOnException() {}, props: {} }) as unknown as ExecutionContext;

/** A browser: keeps cookies per name and sends them on every request. */
export class Browser {
  readonly cookies = new Map<string, string>();

  constructor(
    private readonly worker: ReturnType<typeof createWorker>,
    readonly env: WorkerEnv,
  ) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
    const response = await (
      this.worker.fetch as (r: Request, e: WorkerEnv, c: ExecutionContext) => Promise<Response>
    )(new Request(url, { ...init, headers, redirect: "manual" }), this.env, execCtx());
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const eq = (pair ?? "").indexOf("=");
      const name = (pair ?? "").slice(0, eq).trim();
      const value = (pair ?? "").slice(eq + 1).trim();
      if (attrs.some((a) => /max-age=0\b/i.test(a.trim())) || value === "")
        this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  /** Submit an HTML form from one of our pages (same Origin). */
  post(path: string, fields: Record<string, string>, origin = ORIGIN): Promise<Response> {
    return this.request(path, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  }
}

export function hiddenField(page: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(page);
  if (!match?.[1]) throw new Error(`No ${name} field on the page`);
  return match[1].replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)));
}

async function pkce() {
  const verifier = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: bytesToBase64Url(new Uint8Array(digest)) };
}

export async function registerClient(browser: Browser, name = "Test Client"): Promise<string> {
  const response = await browser.request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (response.status !== 201)
    throw new Error(`register: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { client_id: string }).client_id;
}

/** Walk the full browser flow and return an access token for `clientId`. */
export async function authorizeAndGetToken(browser: Browser, clientId: string): Promise<string> {
  const { verifier, challenge } = await pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "mcp",
    state: "client-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
  });
  const authorizePath = `/oauth/authorize?${query}`;
  let response = await browser.request(authorizePath);
  if (response.status === 302 && response.headers.get("location")?.startsWith("/dashboard/login")) {
    await signIn(browser, response.headers.get("location") as string);
    response = await browser.request(authorizePath);
  }
  if (response.status !== 200)
    throw new Error(`consent page: ${response.status} ${await response.text()}`);
  const handle = hiddenField(await response.text(), "handle");
  const approved = await browser.post(authorizePath, { handle, decision: "approve" });
  const location = new URL(approved.headers.get("location") ?? "");
  const code = location.searchParams.get("code");
  if (approved.status !== 302 || !code) throw new Error(`approve: ${approved.status} ${location}`);
  expectState(location);

  const token = await browser.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${ORIGIN}/mcp`,
    }).toString(),
  });
  if (token.status !== 200) throw new Error(`token: ${token.status} ${await token.text()}`);
  return ((await token.json()) as { access_token: string }).access_token;
}

function expectState(location: URL) {
  if (location.searchParams.get("state") !== "client-state") throw new Error("state not echoed");
}

/** GitHub round trip starting at /dashboard/login…; returns the callback response. */
export async function signIn(browser: Browser, loginPath = "/dashboard/login"): Promise<Response> {
  const start = await browser.request(loginPath);
  const github = new URL(start.headers.get("location") ?? "");
  if (github.origin !== "https://github.com") throw new Error(`login start: ${start.status}`);
  const state = github.searchParams.get("state") ?? "";
  return browser.request(`/oauth/github/callback?code=gh-code&state=${encodeURIComponent(state)}`);
}

export function newBrowser(env: WorkerEnv, fetchFn: ReturnType<typeof mockFetch>["fetch"]) {
  return new Browser(createWorker({ fetch: fetchFn }), env);
}

let rpcId = 1;

export function mcpCall(browser: Browser, token: string | undefined, method: string, params = {}) {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return browser.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
}
