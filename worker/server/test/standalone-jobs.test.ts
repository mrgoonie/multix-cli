/**
 * Job execution in the standalone server end to end over real HTTP, with the
 * real job runner and a fake `multix` binary (no provider, no network; R2
 * uploads go to an injected fetch): an account runs, polls and cancels jobs
 * through MCP and the REST API; a second concurrent job is refused before the
 * runner is called; the slots come back only once a job's CLI has exited; a
 * job the executor refuses gives its slots back; shutting down with a poll
 * still open records the job as interrupted, stops its CLI and frees its
 * slots before the database closes; a restart never runs a job again and
 * clears every slot left behind; no provider key or R2 credential reaches a
 * response, a job file, a stored row or a log line.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runJob as realRunJob } from "../../container/job-runner.mjs";
import { bytesToBase64 } from "../../src/accounts/base64.js";
import { resolveAppContext } from "../../src/app-context.js";
import { jobCapsFrom } from "../../src/config.js";
import {
  type JobQuotaNamespace,
  SERVER_SLOTS_NAME,
  durableJobQuota,
} from "../../src/jobs/account-job-quota.js";
import { type JobSpec, SERVER_AT_CAPACITY_ERROR } from "../../src/jobs/job-protocol.js";
import { type MultixHttpServer, createHttpServer } from "../http-server.js";
import { type LocalQuotaStub, cliRunner, resolveExecutable } from "../local-jobs.js";
import { shutdownServer } from "../server-shutdown.js";
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
/** Fake R2 settings: the upload goes to `uploadFetch`, never to the network. */
const R2 = {
  accountId: "0123456789abcdef0123456789abcdef",
  accessKeyId: "R2ACCESSKEYID0123456789",
  secretAccessKey: "r2-secret-access-key-standalone-0123456789",
  bucket: "multix-outputs",
  publicBaseUrl: "https://files.example.com",
};

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
/** R2 object URLs the runner uploaded to. */
const uploads: string[] = [];

/** Accepts a PUT to the fake R2 bucket; anything else fails, so no request leaves the process. */
async function uploadFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.host !== `${R2.accountId}.r2.cloudflarestorage.com` || init?.method !== "PUT") {
    throw new Error("unexpected request in a test");
  }
  uploads.push(url.pathname);
  return new Response(null, { status: 200 });
}

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
        return realRunJob(spec, { ...options, bin: HOLD_BIN, fetch: uploadFetch });
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

async function stop(running: Running, timeoutMs = 5000): Promise<void> {
  await shutdownServer(running.app, running.http, running.db, timeoutMs);
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

function quotaNamespace(): JobQuotaNamespace {
  return (current as Running).app.env.MULTIX_JOB_QUOTA as unknown as JobQuotaNamespace;
}

/** Job ids holding a slot in a quota object (an account id, or the server-wide object). */
function slotsOf(name: string): Promise<string[]> {
  return (quotaNamespace().getByName(name) as LocalQuotaStub).heldJobIds();
}

function jobFiles(): string[] {
  return readdirSync(stateDir).filter((name) => name.endsWith(".json"));
}

function jobRecord(jobId: string): { view: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(stateDir, `${jobId}.json`), "utf8"));
}

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
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
  let userId = "";

  it("runs a job through MCP and refuses a second one before the runner is called", async () => {
    userId = String((await api("GET", "/me")).body.id);
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

  it("keeps a canceled job's slots until its CLI exits, then runs the next job", async () => {
    const polled = await api("GET", `/jobs/${heldJob}`);
    expect(polled.status).toBe(202);
    expect(polled.body).toMatchObject({ job_id: heldJob, status: "running" });
    const canceled = await mcpTool("multix_job_cancel", { job_id: heldJob });
    expect(canceled.structuredContent).toMatchObject({ status: "canceled" });

    // The fake CLI takes a moment to exit after SIGTERM. Until it has, the
    // quota still counts the job, so the next one is refused before any
    // record is written or the runner is called (not by the executor).
    const filesBefore = jobFiles().length;
    const early = await api("POST", "/jobs", runArgs("quick"));
    expect(early.status).toBe(429);
    expect(current?.app.jobs?.activeJobs()).toBe(1);
    expect(jobFiles()).toHaveLength(filesBefore);
    expect(runnerCalls).toHaveLength(1);

    let third = early;
    await until(async () => {
      third = await api("POST", "/jobs", runArgs("quick", 20));
      return third.status !== 429;
    }, "the canceled job's slots");
    expect(third.status).toBe(200);
    expect(third.body).toMatchObject({ status: "succeeded", exit_code: 0 });
    expect(String(third.body.stderr_tail)).toContain("[redacted]");
    expect(third.body.outputs).toEqual([{ name: "image.png", url: null, bytes: 3 }]);
    expect(third.body.note).toMatch(/Output storage is not configured/);
    const status = await mcpTool("multix_job_status", { job_id: String(third.body.job_id) });
    expect(status.structuredContent).toMatchObject({ status: "succeeded" });
    expect(runnerCalls).toHaveLength(2);
    // No job was ever refused by the executor: the quota alone kept the cap.
    for (const name of jobFiles()) {
      expect(readFileSync(join(stateDir, name), "utf8")).not.toContain(SERVER_AT_CAPACITY_ERROR);
    }
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

  it("gives back the slots of a job the executor refuses after the quota admitted it", async () => {
    const held = await api("POST", "/jobs", runArgs("hold the executor"));
    expect(held.status).toBe(202);
    const heldId = String(held.body.job_id);
    await until(() => runnerCalls.length === 3, "the runner");
    // Free the quota while the executor is still full: the quota admits the
    // next job and the executor refuses it.
    const quota = durableJobQuota(quotaNamespace(), jobCapsFrom((current as Running).app.env));
    await quota.release(userId, heldId);

    const refused = await api("POST", "/jobs", runArgs("quick"));
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: { code: "busy" } });
    expect(runnerCalls).toHaveLength(3);
    const refusedFile = jobFiles().find((name) =>
      readFileSync(join(stateDir, name), "utf8").includes(SERVER_AT_CAPACITY_ERROR),
    );
    expect(refusedFile).toBeDefined();
    await until(
      async () => (await slotsOf(SERVER_SLOTS_NAME)).length === 0,
      "the refused job's server slot",
    );
    expect(await slotsOf(userId)).toEqual([]);

    await mcpTool("multix_job_cancel", { job_id: heldId });
    await until(() => current?.app.jobs?.activeJobs() === 0, "the canceled CLI to exit");
  });

  it("on shutdown with a poll still open, records the job as interrupted and stops its CLI", async () => {
    const pidFile = join(dir, "cli.pid");
    const poll = api("POST", "/jobs", runArgs(`hold across a restart pid=${pidFile}`, 25));
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "", "the CLI");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(runnerCalls).toHaveLength(4);
    const jobId = jobFiles()
      .map((name) => name.slice(0, -".json".length))
      .find((id) => jobRecord(id).view.status === "running");
    expect(jobId).toBeDefined();

    // The drain budget is longer than the poll's wait: shutdown must not
    // wait for the poll to time out before it stops the job.
    const started = Date.now();
    await stop(current as Running, 30_000);
    expect(Date.now() - started).toBeLessThan(10_000);
    const answered = await poll;
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ job_id: jobId, status: "failed" });
    expect(String(answered.body.error)).toMatch(INTERRUPTED);
    expect(jobRecord(String(jobId)).view).toMatchObject({ status: "failed", interrupted: true });
    expect(processGone(pid)).toBe(true);
    expect(seen.join("\n")).not.toMatch(/job_slot_release_failed|job_events_publish_failed/);

    // A restart never runs the job again; its slots were freed at shutdown.
    await start();
    expect(runnerCalls).toHaveLength(4);
    expect(await slotsOf(SERVER_SLOTS_NAME)).toEqual([]);
    expect(await slotsOf(userId)).toEqual([]);
    const after = await api("GET", `/jobs/${jobId}`);
    expect(after.body).toMatchObject({ status: "failed" });
    expect(String(after.body.error)).toMatch(INTERRUPTED);
    const next = await api("POST", "/jobs", runArgs("quick", 20));
    expect(next.body).toMatchObject({ status: "succeeded" });
  }, 30_000);

  it("after a crash, clears every slot left behind, account slots included", async () => {
    // One job per account: any account slot left behind would refuse the next job.
    vars.MULTIX_MAX_JOBS_PER_ACCOUNT = "1";
    await stop(current as Running);
    await start();
    const quota = durableJobQuota(quotaNamespace(), jobCapsFrom((current as Running).app.env));
    // A job the dead process had started: its record says running and it holds both slots.
    const crashed = crypto.randomUUID();
    expect(await quota.acquire(userId, crashed)).toBe("ok");
    await stop(current as Running);
    writeFileSync(
      join(stateDir, `${crashed}.json`),
      JSON.stringify({
        owner: { userId, command: "gemini generate" },
        view: { status: "running", createdAt: Date.now() },
      }),
      { mode: 0o600 },
    );
    const calls = runnerCalls.length;
    await start();
    expect(runnerCalls).toHaveLength(calls);
    expect(jobRecord(crashed).view).toMatchObject({ status: "failed", interrupted: true });
    const next = await api("POST", "/jobs", runArgs("quick", 20));
    expect(next.body).toMatchObject({ status: "succeeded" });

    // Slots of jobs the executor never recorded (stopped in between): both
    // slots of one, and only the account slot of another.
    const orphan = crypto.randomUUID();
    const q2 = durableJobQuota(quotaNamespace(), jobCapsFrom((current as Running).app.env));
    expect(await q2.acquire(userId, orphan)).toBe("ok");
    expect((await api("POST", "/jobs", runArgs("quick"))).status).toBe(429);
    await stop(current as Running);
    await start();
    expect(await slotsOf(userId)).toEqual([]);
    expect((await api("POST", "/jobs", runArgs("quick", 20))).body).toMatchObject({
      status: "succeeded",
    });

    expect(await quotaNamespace().getByName(userId).acquire(crypto.randomUUID(), 1)).toBe(true);
    const busy = await api("POST", "/jobs", runArgs("quick"));
    expect(busy.status).toBe(429);
    expect(JSON.stringify(busy.body)).toMatch(/already have 1 running job/);
    await stop(current as Running);
    await start();
    const afterAccountOnly = await api("POST", "/jobs", runArgs("quick", 20));
    expect(afterAccountOnly.body).toMatchObject({ status: "succeeded" });
  }, 30_000);

  it("uploads outputs with the account's R2 settings without exposing them", async () => {
    const app = await resolveAppContext((current as Running).app.env, {});
    await app?.accounts.saveR2Settings(userId, R2);
    const done = await api("POST", "/jobs", runArgs("quick", 20));
    expect(done.body).toMatchObject({ status: "succeeded" });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatch(new RegExp(`^/${R2.bucket}/multix/[0-9a-f]{16}/`));
    const outputs = done.body.outputs as { name: string; url: string }[];
    expect(outputs[0]?.url).toMatch(new RegExp(`^${R2.publicBaseUrl}/multix/`));
  });

  it("never writes or returns a provider key or an R2 credential", async () => {
    const secrets = [GEMINI_KEY, R2.secretAccessKey, R2.accessKeyId];
    const files = jobFiles();
    expect(files.length).toBeGreaterThan(3);
    const db = (current as Running).db.db;
    const rows = [
      ...(db.prepare("SELECT CAST(value AS TEXT) AS v FROM kv").all() as { v: string }[]),
      ...(db.prepare("SELECT CAST(value AS TEXT) AS v FROM do_storage").all() as { v: string }[]),
    ];
    expect(seen.length).toBeGreaterThan(10);
    const stored = [
      ...files.map((name) => readFileSync(join(stateDir, name), "utf8")),
      ...rows.map((row) => row.v ?? ""),
      ...seen,
    ];
    for (const secret of secrets) {
      for (const entry of stored) expect(entry).not.toContain(secret);
    }
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

describe("cliRunner", () => {
  it("runs the CLI with the executor's egress proxy settings", async () => {
    const fake = decodeURIComponent(
      new URL("../../test/fixtures/fake-multix.mjs", import.meta.url).pathname,
    );
    const result = (await cliRunner(fake)(
      {
        jobId: "11111111-2222-4333-8444-555555555555",
        argv: ["x", "--print-proxy"],
        env: {},
        inputs: [],
        timeoutMs: 10_000,
      } as unknown as JobSpec,
      {
        signal: new AbortController().signal,
        egressEnv: { HTTPS_PROXY: "http://multix:proxy-credential-value@127.0.0.1:9" },
      },
    )) as { stderrTail: string };
    expect(result.stderrTail).toContain("proxy http://");
    expect(result.stderrTail).not.toContain("proxy undefined");
  });
});
