/**
 * The standalone Multix app: the Worker's own `createWorker()` handler with
 * Node implementations of its bindings (see durable-object-host.ts,
 * sqlite-kv-namespace.ts, memory-rate-limiter.ts). Nothing here re-implements
 * a route: /mcp, /dashboard, OAuth, /api/v1, /api/docs and /health are the
 * Worker's. This module adds only the readiness probe, /health/ready.
 *
 * Job execution is opt-in (`jobs` option, MULTIX_LOCAL_JOBS=true in
 * multix-server.ts). With it, MULTIX_JOB_QUOTA is the real AccountJobQuota
 * Durable Object on SQLite and MULTIX_JOBS is the local child-process
 * executor (local-jobs.ts), so `multix_run`, `multix_job_status`,
 * `multix_job_cancel` and /api/v1/jobs run the Worker's own code. The
 * server-wide job cap (MULTIX_MAX_JOBS_TOTAL) is lowered to the executor's
 * MULTIX_LOCAL_MAX_CONCURRENT_JOBS, so a job over the cap is refused by the
 * quota check before anything runs. Without it neither binding exists and
 * the job tools and endpoints are not offered; `multix_catalog`, skills,
 * events, accounts, API keys and the dashboard work either way.
 */

import { publicOrigin, resolveAppContext } from "../src/app-context.js";
import { type WorkerEnv, jobCapsFrom } from "../src/config.js";
import { AccountEvents } from "../src/events/account-events.js";
import { json } from "../src/http-responses.js";
import { createWorker } from "../src/index.js";
import { logEvent } from "../src/redaction.js";
import { AccountSkills } from "../src/skills/account-skills.js";
import { DurableObjectHost } from "./durable-object-host.js";
import {
  LocalAccountJobQuota,
  type LocalJobs,
  type LocalJobsOptions,
  startLocalJobs,
} from "./local-jobs.js";
import { MemoryRateLimiter } from "./memory-rate-limiter.js";
import type { MultixDatabase } from "./sqlite-database.js";
import { SqliteKvNamespace, sweepExpired } from "./sqlite-kv-namespace.js";

export const READY_PATH = "/health/ready";

export interface StandaloneOptions {
  database: MultixDatabase;
  /** Worker string vars (secrets and MULTIX_* settings), see server-config.ts `workerVars`. */
  vars: Record<string, string>;
  mcpRateLimit?: number;
  authRateLimit?: number;
  /** Run jobs as child processes of this server; absent: no job tools. */
  jobs?: LocalJobsOptions;
  now?: () => number;
}

export interface StandaloneApp {
  env: WorkerEnv;
  host: DurableObjectHost;
  /** The local executor when job execution is enabled. */
  jobs?: LocalJobs;
  /** Handle one request (the public origin is already in its URL). */
  fetch(request: Request): Promise<Response>;
  /** Mark the app as shutting down: readiness answers 503 from now on. */
  drain(): void;
  /**
   * Wait (up to `timeoutMs`) for background work and stop the job executor
   * (running jobs are recorded as interrupted), then stop alarms.
   */
  stop(timeoutMs: number): Promise<void>;
  sweep(): number;
}

export async function createStandaloneApp(options: StandaloneOptions): Promise<StandaloneApp> {
  const { database } = options;
  const now = options.now ?? Date.now;
  const env = {
    ...options.vars,
    OAUTH_KV: new SqliteKvNamespace(database, "OAUTH_KV", now) as unknown as KVNamespace,
    ACCOUNTS_KV: new SqliteKvNamespace(database, "ACCOUNTS_KV", now) as unknown as KVNamespace,
    MCP_RATE_LIMITER: new MemoryRateLimiter(options.mcpRateLimit ?? 60, 60, now),
    AUTH_RATE_LIMITER: new MemoryRateLimiter(options.authRateLimit ?? 30, 60, now),
  } as unknown as WorkerEnv;
  const host = new DurableObjectHost(
    database,
    () => env,
    (level, event, fields) => logEvent(level, event, fields as never),
    now,
  );
  const mutableEnv = env as unknown as Record<string, unknown>;
  mutableEnv.MULTIX_EVENTS = host.namespace("MULTIX_EVENTS", AccountEvents as never);
  mutableEnv.MULTIX_SKILLS = host.namespace("MULTIX_SKILLS", AccountSkills as never);
  let jobs: LocalJobs | undefined;
  if (options.jobs) {
    mutableEnv.MULTIX_JOB_QUOTA = host.namespace("MULTIX_JOB_QUOTA", LocalAccountJobQuota as never);
    jobs = await startLocalJobs(env, options.jobs);
    // One CLI process per slot: the quota's server-wide cap never exceeds the executor's.
    const total = Math.min(jobCapsFrom(env).total, jobs.maxConcurrent);
    mutableEnv.MULTIX_MAX_JOBS_TOTAL = String(total);
    mutableEnv.MULTIX_JOBS = jobs.namespace;
  }
  host.resumeAlarms();

  const worker = createWorker();
  const background = new Set<Promise<unknown>>();
  let draining = false;

  async function ready(): Promise<Response> {
    const checks: Record<string, "ok" | "fail"> = { storage: "ok", config: "ok" };
    if (jobs) checks.jobs = jobs.accepting() ? "ok" : "fail";
    try {
      database.check();
    } catch {
      checks.storage = "fail";
    }
    if (!publicOrigin(env) || !(await resolveAppContext(env, {}))) checks.config = "fail";
    const ok = !draining && Object.values(checks).every((c) => c === "ok");
    return json(ok ? 200 : 503, { ok, draining, jobs: jobs ? "enabled" : "disabled", checks });
  }

  return {
    env,
    host,
    jobs,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === READY_PATH) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { allow: "GET, HEAD" },
          });
        }
        return ready();
      }
      const ctx = {
        waitUntil(promise: Promise<unknown>) {
          const tracked = Promise.resolve(promise).catch((error) =>
            logEvent("warn", "background_task_failed", {
              error: error instanceof Error ? error.name : "unknown",
            }),
          );
          background.add(tracked);
          tracked.finally(() => background.delete(tracked));
        },
        passThroughOnException() {},
        props: {},
      } as unknown as ExecutionContext;
      return (await worker.fetch?.(request as never, env, ctx)) as unknown as Response;
    },
    drain() {
      draining = true;
    },
    async stop(timeoutMs) {
      draining = true;
      const started = Date.now();
      const left = () => Math.max(0, timeoutMs - (Date.now() - started));
      const deadline = new Promise((resolve) => setTimeout(resolve, timeoutMs).unref());
      await Promise.race([
        Promise.allSettled([...background, ...(jobs ? [jobs.close()] : [])]),
        deadline,
      ]);
      await host.stop(left());
    },
    sweep: () => sweepExpired(database, now()),
  };
}
