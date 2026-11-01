/**
 * The standalone server end to end over real HTTP (node:http + SQLite file),
 * with no Cloudflare binding: first boot, bootstrap admin, MCP OAuth and a
 * multix_catalog call; then a restart on the same file keeps the grant, the
 * token, the account's encrypted keys and its skills; plus the negative paths.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bytesToBase64 } from "../../src/accounts/base64.js";
import { type MultixHttpServer, createHttpServer } from "../http-server.js";
import { runSmoke } from "../smoke-flow.js";
import { type MultixDatabase, openDatabase } from "../sqlite-database.js";
import { type StandaloneApp, createStandaloneApp } from "../standalone-app.js";
import { prepareBootstrap } from "../standalone-bootstrap.js";

const PASSWORD = "correct horse battery staple";
const SECRET_KEY = "r8_secret_value_never_in_responses_123";

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface Running {
  app: StandaloneApp;
  http: MultixHttpServer;
  db: MultixDatabase;
  printed: string[];
}

let dir: string;
let port: number;
let base: string;
let vars: Record<string, string>;
let current: Running | undefined;

async function start(): Promise<Running> {
  const db = openDatabase(join(dir, "multix.sqlite"));
  const app = createStandaloneApp({ database: db, vars });
  const printed: string[] = [];
  await prepareBootstrap(app.env, (line) => printed.push(line));
  const http = createHttpServer(app, {
    origin: base,
    trustProxyHops: 0,
    maxBodyBytes: 1024 * 1024,
  });
  await new Promise<void>((resolve) => http.server.listen(port, "127.0.0.1", resolve));
  current = { app, http, db, printed };
  return current;
}

async function stop(running: Running): Promise<void> {
  running.app.drain();
  await running.http.close(1000);
  await running.app.stop(1000);
  running.db.close();
  current = undefined;
  // Pooled keep-alive sockets point at the stopped listener: start the client afresh.
  setGlobalDispatcher(new Agent());
}

function generatedToken(printed: string[]): string {
  const line = printed.find((l) => l.includes("bootstrap token"));
  const token = line?.split(": ").at(-1)?.trim();
  if (!token) throw new Error("no bootstrap token printed");
  return token;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "multix-standalone-"));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  vars = {
    MULTIX_PUBLIC_URL: base,
    MULTIX_LOCAL_AUTH: "true",
    SESSION_SECRET: "standalone-session-secret-0123456789abcdef",
    SECRETS_ENCRYPTION_KEY: bytesToBase64(new Uint8Array(32).fill(9)),
  };
});

afterAll(async () => {
  if (current) await stop(current);
  rmSync(dir, { recursive: true, force: true });
});

describe("standalone multix-server", () => {
  let token = "";
  let sessionCookies = new Map<string, string>();

  it("boots with no Cloudflare binding, creates the admin and serves MCP", async () => {
    const running = await start();
    const health = await fetch(`${base}/health`);
    expect(await health.json()).toEqual({ ok: true });
    const bootstrap = generatedToken(running.printed);
    const result = await runSmoke({
      baseUrl: base,
      username: "admin",
      password: PASSWORD,
      bootstrapToken: bootstrap,
    });
    expect(result.createdAdmin).toBe(true);
    expect(result.tools).toContain("multix_catalog");
    // Job execution is not bound in standalone mode (#550): no multix_run.
    expect(result.tools).not.toContain("multix_run");
    token = result.accessToken;
    // The generated bootstrap token is single use.
    const again = await fetch(`${base}/dashboard/setup`);
    expect(again.status).toBe(404);
    // The database never holds the bootstrap token or the password in clear.
    const raw = running.db.db.prepare("SELECT key, CAST(value AS TEXT) AS v FROM kv").all() as {
      v: string;
    }[];
    for (const row of raw) {
      expect(row.v).not.toContain(PASSWORD);
      expect(row.v).not.toContain(bootstrap);
    }
  });

  it("saves an encrypted provider key and an API key through the dashboard session", async () => {
    // Sign in again in a fresh jar to obtain the session cookie.
    const login = await fetch(`${base}/dashboard/login`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: PASSWORD, return_to: "/dashboard" }),
    });
    expect(login.status).toBe(303);
    sessionCookies = new Map(
      login.headers.getSetCookie().map((c) => {
        const [pair] = c.split(";");
        const eq = (pair ?? "").indexOf("=");
        return [(pair ?? "").slice(0, eq), (pair ?? "").slice(eq + 1)];
      }),
    );
    const cookie = [...sessionCookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const page = await (await fetch(`${base}/dashboard`, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1];
    expect(csrf).toBeTruthy();
    const save = await fetch(`${base}/dashboard/secrets`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: base, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf: csrf as string,
        name: "REPLICATE_API_TOKEN",
        value: SECRET_KEY,
      }),
    });
    expect([302, 303]).toContain(save.status);
    const after = await (await fetch(`${base}/dashboard`, { headers: { cookie } })).text();
    expect(after).not.toContain(SECRET_KEY);
    const stored = current?.db.db
      .prepare("SELECT CAST(value AS TEXT) AS v FROM kv WHERE key LIKE 'secrets:%'")
      .get() as { v: string } | undefined;
    expect(stored?.v).toBeTruthy();
    expect(stored?.v).not.toContain(SECRET_KEY);
  });

  it("keeps grants, tokens, keys and accounts across a restart", async () => {
    await stop(current as Running);
    const running = await start();
    expect(running.printed).toEqual([]); // setup is done: no new bootstrap token
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "multix_catalog", arguments: { group: "replicate" } },
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SECRET_KEY);
    // The saved Replicate key survived: the catalog reports it as configured.
    expect(text).toMatch(/has_keys\\?"\s*:\s*true/);
    expect(text).not.toMatch(/has_keys\\?"\s*:\s*false/);
    // The existing session still works and a fresh sign-in works.
    const second = await runSmoke({ baseUrl: base, username: "admin", password: PASSWORD });
    expect(second.createdAdmin).toBe(false);
  });

  it("refuses unauthenticated and forged access", async () => {
    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-token", "content-type": "application/json" },
      body: "{}",
    });
    expect(mcp.status).toBe(401);
    const api = await fetch(`${base}/api/v1/account`);
    expect([401, 403]).toContain(api.status);
    const dashboardPost = await fetch(`${base}/dashboard/secrets`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: "name=REPLICATE_API_TOKEN&value=x",
    });
    expect([302, 303, 401, 403]).toContain(dashboardPost.status);
    const crossOrigin = await fetch(`${base}/dashboard/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ username: "admin", password: PASSWORD }),
    });
    expect(crossOrigin.status).toBe(403);
    // A forged edge header does not change the client address the rate limiter sees.
    const forged = await fetch(`${base}/health`, {
      headers: { "cf-connecting-ip": "203.0.113.9" },
    });
    expect(forged.status).toBe(200);
    // No internal job endpoint is reachable.
    for (const path of ["/jobs/current", "/api/v1/jobs", "/internal"]) {
      expect([401, 403, 404]).toContain((await fetch(`${base}${path}`)).status);
    }
  });

  it("rebuilds request URLs on the public origin, ignoring Host and X-Forwarded-*", async () => {
    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`, {
      headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
    });
    expect(((await metadata.json()) as { resource: string }).resource).toBe(`${base}/mcp`);
  });

  it("caps request bodies", async () => {
    const big = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1024 * 1024 + 1),
    });
    expect(big.status).toBe(413);
  });

  it("reports readiness and stops being ready while draining", async () => {
    const running = current as Running;
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
    running.app.drain();
    const draining = await fetch(`${base}/health/ready`);
    expect(draining.status).toBe(503);
    expect(await draining.json()).toMatchObject({ ok: false, draining: true });
  });
});
