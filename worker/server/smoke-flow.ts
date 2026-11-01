/**
 * End-to-end check of a running standalone server over real HTTP, as an MCP
 * client and its user would do it: readiness, first-boot admin setup (or
 * sign-in), dynamic client registration, PKCE authorization with consent,
 * token exchange, then `initialize`, `tools/list` and a harmless
 * `multix_catalog` call. Used by the integration test and by
 * `npm run smoke:server` against a container. Never prints tokens or passwords.
 */

export interface SmokeOptions {
  /** Base URL of the server, e.g. http://localhost:3000 (must equal MULTIX_PUBLIC_URL). */
  baseUrl: string;
  username: string;
  password: string;
  /** Needed only while the admin does not exist yet. */
  bootstrapToken?: string;
  log?: (line: string) => void;
}

export interface SmokeResult {
  createdAdmin: boolean;
  accessToken: string;
  clientId: string;
  tools: string[];
  catalogText: string;
}

const REDIRECT_URI = "http://127.0.0.1:8976/callback";

class Client {
  readonly cookies = new Map<string, string>();
  constructor(readonly base: string) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const response = await fetch(new URL(path, this.base), {
      ...init,
      headers,
      redirect: "manual",
    });
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const eq = (pair ?? "").indexOf("=");
      const name = (pair ?? "").slice(0, eq).trim();
      const value = (pair ?? "").slice(eq + 1).trim();
      if (value === "" || attrs.some((a) => /max-age=0\b/i.test(a.trim())))
        this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  form(path: string, fields: Record<string, string>): Promise<Response> {
    return this.request(path, {
      method: "POST",
      headers: {
        origin: new URL(this.base).origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
    });
  }
}

function fail(step: string, response: Response, body?: string): never {
  throw new Error(`${step}: HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ""}`);
}

function hiddenField(page: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(page);
  if (!match?.[1]) throw new Error(`No ${name} field on the page`);
  return match[1].replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)));
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** JSON body of an MCP response (plain JSON, or the first SSE `data:` line). */
async function rpcBody(response: Response): Promise<{ result?: unknown; error?: unknown }> {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line?.slice(5) ?? "{}");
  }
  return JSON.parse(text);
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const log = options.log ?? (() => undefined);
  const client = new Client(options.baseUrl);
  const origin = new URL(options.baseUrl).origin;

  const ready = await client.request("/health/ready");
  if (ready.status !== 200) fail("readiness", ready, await ready.text());
  log("ready: ok");

  // 1. First boot: create the admin with the bootstrap token, or sign in.
  let createdAdmin = false;
  const setupPage = await client.request("/dashboard/setup");
  if (setupPage.status === 200) {
    if (!options.bootstrapToken) throw new Error("setup is open but no bootstrap token was given");
    const setup = await client.form("/dashboard/setup", {
      token: options.bootstrapToken,
      username: options.username,
      password: options.password,
      confirm: options.password,
    });
    if (setup.status !== 303) fail("bootstrap setup", setup, await setup.text());
    createdAdmin = true;
    log("bootstrap admin: created");
  } else {
    const login = await client.form("/dashboard/login", {
      username: options.username,
      password: options.password,
      return_to: "/dashboard",
    });
    if (login.status !== 303) fail("sign-in", login, await login.text());
    log("sign-in: ok");
  }
  const dashboard = await client.request("/dashboard");
  const dashboardHtml = await dashboard.text();
  if (dashboard.status !== 200 || !dashboardHtml.includes(options.username)) {
    fail("dashboard", dashboard);
  }
  log("dashboard: signed in");

  // 2. MCP client: discovery, registration, PKCE authorization with consent, token.
  const unauthenticated = await client.request("/mcp", { method: "POST" });
  if (unauthenticated.status !== 401) fail("unauthenticated /mcp must be 401", unauthenticated);
  const metadata = await client.request("/.well-known/oauth-protected-resource/mcp");
  const resource = ((await metadata.json()) as { resource?: string }).resource;
  if (resource !== `${origin}/mcp`) throw new Error(`resource metadata: ${resource}`);

  const register = await client.request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "multix smoke test",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (register.status !== 201) fail("client registration", register, await register.text());
  const clientId = ((await register.json()) as { client_id: string }).client_id;

  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "mcp",
    state: "smoke-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  });
  const authorizePath = `/oauth/authorize?${query}`;
  const consent = await client.request(authorizePath);
  const consentHtml = await consent.text();
  if (consent.status !== 200) fail("consent page", consent, consentHtml);
  const approved = await client.form(authorizePath, {
    handle: hiddenField(consentHtml, "handle"),
    decision: "approve",
  });
  const location = new URL(approved.headers.get("location") ?? "", origin);
  const code = location.searchParams.get("code");
  if (approved.status !== 302 || !code || location.searchParams.get("state") !== "smoke-state") {
    fail("consent approval", approved);
  }
  const tokenResponse = await client.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    }).toString(),
  });
  if (tokenResponse.status !== 200)
    fail("token exchange", tokenResponse, await tokenResponse.text());
  const accessToken = ((await tokenResponse.json()) as { access_token: string }).access_token;
  log("oauth: access token issued");

  // 3. MCP over Streamable HTTP.
  let id = 1;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(new URL("/mcp", options.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
    });
    if (response.status !== 200) fail(`mcp ${method}`, response, await response.text());
    const body = await rpcBody(response);
    if (body.error) throw new Error(`mcp ${method}: ${JSON.stringify(body.error).slice(0, 200)}`);
    return body.result as Record<string, unknown>;
  };
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "multix-smoke", version: "1.0.0" },
  });
  const listed = await rpc("tools/list");
  const tools = ((listed.tools as { name: string }[]) ?? []).map((t) => t.name);
  if (!tools.includes("multix_catalog"))
    throw new Error(`multix_catalog missing: ${tools.join(",")}`);
  const called = await rpc("tools/call", { name: "multix_catalog", arguments: {} });
  const content = (called.content as { type: string; text?: string }[]) ?? [];
  const catalogText = content.map((c) => c.text ?? "").join("\n");
  if (called.isError || catalogText.length === 0)
    throw new Error("multix_catalog returned an error");
  log(`mcp: ${tools.length} tools, multix_catalog ok (${catalogText.length} chars)`);
  return { createdAdmin, accessToken, clientId, tools, catalogText };
}
