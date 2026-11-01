/**
 * Job execution in the standalone server end to end over real HTTP, with the
 * real job runner and a fake `multix` binary (no provider, no network): an
 * account runs, polls and cancels jobs through MCP and the REST API; a second
 * concurrent job is refused before the runner is called; the slot comes back
 * when a job ends; a restart records a running job as interrupted and frees
 * its slot; no key value reaches a response, a job file or a log line.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runJob as realRunJob } from "../../container/job-runner.mjs";
import { bytesToBase64 } from "../../src/accounts/base64.js";
import { jobCapsFrom } from "../../src/config.js";
import { durableJobQuota } from "../../src/jobs/account-job-quota.js";
import type { JobSpec } from "../../src/jobs/job-protocol.js";
import { type MultixHttpServer, createHttpServer } from "../http-server.js";
import { resolveExecutable } from "../local-jobs.js";
import { runSmoke } from "../smoke-flow.js";
import { type MultixDatabase, openDatabase } from "../sqlite-database.js";
import { type StandaloneApp, createStandaloneApp } from "../standalone-app.js";
import { prepareBootstrap } from "../standalone-bootstrap.js";

const PASSWORD = "correct horse battery staple";
const GEMINI_KEY = "AIza-standalone-gemini-secret-0123456789";
const HOLD_BIN = decodeURIComponent(
  new URL("./fixtures/hold-multix.mjs", import.meta.url).pathname,
);
const INTERRUPTED = /server stopped while the job was running/i;

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
let stateDir: string;
let port: number;
let base: string;
let vars: Record<string, string>;
let current: Running | undefined;
/** Job ids the runner was called for, in order. */
const runnerCalls: string[] = [];
/** Every response body and log line, checked for the key at the end. */
const seen: string[] = [];

async function start(): Promise<Running> {
  const db = openDatabase(join(dir, "multix.sqlite"));
  const app = await createStandaloneApp({
    database: db,
    vars,
    jobs: {
      stateDir,
      maxConcurrent: 1,
      closeTimeoutMs: 2_000,
      runJob: (spec: JobSpec, options: { signal: AbortSignal }) => {
        runnerCalls.push(spec.jobId);
        return realRunJob(spec, { ...options, bin: HOLD_BIN });
      },
    },
  });
  const printed: string[] = [];
  await prepareBootstrap(app.env, (line) => printed.push(line));
  const http = createHttpServer(app, { origin: base, trustProxyHops: 0, maxBodyBytes: 1 << 20 });
  await new Promise<void>((resolve) => http.server.listen(port, "127.0.0.1", resolve));
  current = { app, http, db, printed };
  return current;
}

async function stop(running: Running): Promise<void> {
  running.app.drain();
  await running.http.close(1000);
  await running.app.stop(5000);
  running.db.close();
  current = undefined;
  setGlobalDispatcher(new Agent());
}

async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function text(response: Response): Promise<string> {
  const body = await response.text();
  seen.push(body);
  return body;
}

let accessToken = "";
let apiKey = "";

async function mcpTool(name: string, args: Record<string, unknown>) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(response.status).toBe(200);
  const raw = await text(response);
  const line = raw.split("\n").find((l) => l.startsWith("data:"));
  const message = JSON.parse(line ? line.slice(5) : raw) as {
    result: {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content: { text: string }[];
    };
  };
  return message.result;
}

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await text(response);
  return { status: response.status, body: JSON.parse(raw) as Record<string, unknown> };
}

const runArgs = (prompt: string, wait = 0) => ({
  command: "gemini generate",
  options: { prompt },
  wait_seconds: wait,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "multix-jobs-"));
  stateDir = join(dir, "jobs");
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  vars = {
    MULTIX_PUBLIC_URL: base,
    MULTIX_LOCAL_AUTH: "true",
    MULTIX_MCP_UNCAPPED_SPEND: "deny",
    SESSION_SECRET: "standalone-jobs-session-secret-0123456789",
    SECRETS_ENCRYPTION_KEY: bytesToBase64(new Uint8Array(32).fill(7)),
  };
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => {
      seen.push(parts.map(String).join(" "));
    });
  }
});

afterAll(async () => {
  if (current) await stop(current);
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("standalone multix-server job execution", () => {
  it("offers the job tools and caps the server-wide quota at the executor's concurrency", async () => {
    const running = await start();
    const bootstrap = running.printed
      .find((l) => l.includes("bootstrap token"))
      ?.split(": ")
      .at(-1);
    const smoke = await runSmoke({
      baseUrl: base,
      username: "admin",
      password: PASSWORD,
      bootstrapToken: bootstrap?.trim(),
    });
    accessToken = smoke.accessToken;
    expect(smoke.tools).toEqual(
      expect.arrayContaining(["multix_run", "multix_job_status", "multix_job_cancel"]),
    );
    expect(jobCapsFrom(running.app.env).total).toBe(1);
    const ready = await fetch(`${base}/health/ready`);
    expect(await ready.json()).toMatchObject({ ok: true, jobs: "enabled", checks: { jobs: "ok" } });
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);

    // An API key from the dashboard session, then the provider key over REST.
    const login = await fetch(`${base}/dashboard/login`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: PASSWORD, return_to: "/dashboard" }),
    });
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const page = await (await fetch(`${base}/dashboard`, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
    const created = await fetch(`${base}/dashboard/api-keys`, {
      method: "POST",
      headers: { origin: base, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, name: "ci" }),
    });
    apiKey = /mxk_[A-Za-z0-9_-]+/.exec(await created.text())?.[0] ?? "";
    expect(apiKey).not.toBe("");
    const saved = await api("PUT", "/provider-keys/GEMINI_API_KEY", { value: GEMINI_KEY });
    expect(saved.status).toBe(200);
  });

  let heldJob = "";

  it("runs a job through MCP and refuses a second one before the runner is called", async () => {
    const first = await mcpTool("multix_run", runArgs("hold this one"));
    expect(first.isError).toBeFalsy();
    heldJob = String(first.structuredContent?.job_id);
    expect(first.structuredContent).toMatchObject({ status: "running" });
    await until(() => runnerCalls.length === 1, "the runner");

    const second = await mcpTool("multix_run", runArgs("quick"));
    expect(second.isError).toBe(true);
    expect(second.content[0]?.text).toMatch(/at capacity/);
    const rest = await api("POST", "/jobs", runArgs("quick"));
    expect(rest.status).toBe(429);
    expect(rest.body).toMatchObject({ error: { code: "busy" } });
    expect(runnerCalls).toHaveLength(1);
  });

  it("polls over REST and cancels over MCP, then the freed slot runs the next job", async () => {
    const polled = await api("GET", `/jobs/${heldJob}`);
    expect(polled.status).toBe(202);
    expect(polled.body).toMatchObject({ job_id: heldJob, status: "running" });
    const canceled = await mcpTool("multix_job_cancel", { job_id: heldJob });
    expect(canceled.structuredContent).toMatchObject({ status: "canceled" });
    await until(() => current?.app.jobs?.activeJobs() === 0, "the canceled CLI to exit");

    const third = await api("POST", "/jobs", runArgs("quick", 20));
    expect(third.status).toBe(200);
    expect(third.body).toMatchObject({ status: "succeeded", exit_code: 0 });
    expect(String(third.body.stderr_tail)).toContain("[redacted]");
    expect(third.body.outputs).toEqual([{ name: "image.png", url: null, bytes: 3 }]);
    expect(third.body.note).toMatch(/R2 storage is not configured/);
    const status = await mcpTool("multix_job_status", { job_id: String(third.body.job_id) });
    expect(status.structuredContent).toMatchObject({ status: "succeeded" });
    expect(runnerCalls).toHaveLength(2);
  });

  it("refuses an input URL on a private or metadata address before the runner is called", async () => {
    for (const url of ["https://169.254.169.254/latest/meta-data", "https://localhost/a.png"]) {
      const refused = await api("POST", "/jobs", {
        command: "gemini image-to-image",
        options: { prompt: "x" },
        inputs: { ref: url },
      });
      expect(refused.status).toBe(400);
    }
    expect(runnerCalls).toHaveLength(2);
  });

  it("records a job running at shutdown as interrupted and frees its slot", async () => {
    const held = await api("POST", "/jobs", runArgs("hold across a restart"));
    expect(held.status).toBe(202);
    const jobId = String(held.body.job_id);
    await until(() => runnerCalls.length === 3, "the runner");
    await stop(current as Running);
    await start();
    const after = await api("GET", `/jobs/${jobId}`);
    expect(after.body).toMatchObject({ status: "failed" });
    expect(String(after.body.error)).toMatch(INTERRUPTED);
    const next = await api("POST", "/jobs", runArgs("quick", 20));
    expect(next.body).toMatchObject({ status: "succeeded" });
  });

  it("after a crash, frees the slot of a job left running and of a job never recorded", async () => {
    const running = current as Running;
    const quota = durableJobQuota(
      running.app.env.MULTIX_JOB_QUOTA as never,
      jobCapsFrom(running.app.env),
    );
    const me = await api("GET", "/me");
    const userId = String(me.body.id);
    // A job the dead process had started: its record says running and it holds both slots.
    const crashed = crypto.randomUUID();
    expect(await quota.acquire(userId, crashed)).toBe("ok");
    await stop(running);
    writeFileSync(
      join(stateDir, `${crashed}.json`),
      JSON.stringify({
        owner: { userId, command: "gemini generate" },
        view: { status: "running", createdAt: Date.now() },
      }),
      { mode: 0o600 },
    );
    await start();
    const recovered = JSON.parse(readFileSync(join(stateDir, `${crashed}.json`), "utf8"));
    expect(recovered.view).toMatchObject({ status: "failed", interrupted: true });
    const next = await api("POST", "/jobs", runArgs("quick", 20));
    expect(next.body).toMatchObject({ status: "succeeded" });

    // A slot taken by a job the executor never recorded (stopped in between).
    const orphan = crypto.randomUUID();
    const q2 = durableJobQuota(
      (current as Running).app.env.MULTIX_JOB_QUOTA as never,
      jobCapsFrom((current as Running).app.env),
    );
    expect(await q2.acquire(userId, orphan)).toBe("ok");
    expect((await api("POST", "/jobs", runArgs("quick"))).status).toBe(429);
    await stop(current as Running);
    await start();
    const afterOrphan = await api("POST", "/jobs", runArgs("quick", 20));
    expect(afterOrphan.body).toMatchObject({ status: "succeeded" });
  });

  it("never writes or returns a key value", async () => {
    const files = readdirSync(stateDir).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThan(3);
    for (const name of files) {
      const stored = readFileSync(join(stateDir, name), "utf8");
      expect(stored).not.toContain(GEMINI_KEY);
    }
    const rows = (current as Running).db.db
      .prepare("SELECT CAST(value AS TEXT) AS v FROM kv")
      .all() as { v: string }[];
    for (const row of rows) expect(row.v ?? "").not.toContain(GEMINI_KEY);
    expect(seen.length).toBeGreaterThan(10);
    for (const entry of seen) expect(entry).not.toContain(GEMINI_KEY);
  });
});

describe("resolveExecutable", () => {
  it("finds an executable on PATH or by absolute path, and nothing else", async () => {
    const fixtures = decodeURIComponent(new URL("./fixtures", import.meta.url).pathname);
    expect(await resolveExecutable("hold-multix.mjs", `/nonexistent:${fixtures}`)).toBe(HOLD_BIN);
    expect(await resolveExecutable(HOLD_BIN, "")).toBe(HOLD_BIN);
    expect(await resolveExecutable("multix-missing-binary", fixtures)).toBeUndefined();
    expect(await resolveExecutable("./hold-multix.mjs", fixtures)).toBeUndefined();
  });
});
