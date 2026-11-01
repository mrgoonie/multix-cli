/**
 * Job execution in the standalone server: the local child-process executor
 * (container/local-executor.mjs) behind the same bindings the Worker uses on
 * Cloudflare, so `multix_run`, the job REST endpoints, quota checks and spend
 * caps run their unchanged code paths.
 *
 *  - MULTIX_JOBS: `getByName(jobId)` answers startJob / jobStatus / cancelJob
 *    from the executor (the Durable Object RPC surface, JobContainerStub).
 *  - MULTIX_JOB_QUOTA: the real AccountJobQuota Durable Object on SQLite,
 *    with one read-only addition used at start-up (`heldJobIds`).
 *
 * When a job reaches its final state (`onFinal`, once per job) its account
 * and server slots are given back and its lifecycle events are published to
 * the owner's AccountEvents object. A failure there is logged (identifiers
 * only) and never crashes the server: slot leases free a slot that was not
 * given back. At start-up the executor records jobs left running by the
 * previous process as interrupted (which calls `onFinal`), then every server
 * slot left behind is released, because no job of this executor is running
 * yet; this also covers a crash between a final write and its release.
 *
 * Provider keys reach the CLI only through the in-memory job spec: the
 * executor never writes a spec. Input downloads use job-network.mjs (public
 * addresses only, checked at connect time); output uploads use the global
 * fetch, which the server's public-fetch guard covers.
 */

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { runJob } from "../container/job-runner.mjs";
import { createLocalExecutor } from "../container/local-executor.mjs";
import type { WorkerEnv } from "../src/config.js";
import type { MultixEvent } from "../src/events/event-catalog.js";
import { jobEvents } from "../src/events/job-events.js";
import {
  AccountJobQuota,
  type AccountJobQuotaStub,
  type JobSlots,
  SERVER_SLOTS_NAME,
  SLOTS_KEY,
  durableJobQuota,
} from "../src/jobs/account-job-quota.js";
import type { JobSpec, JobView } from "../src/jobs/job-protocol.js";
import type { JobContainerStub, JobNamespace } from "../src/jobs/job-store.js";
import { logEvent } from "../src/redaction.js";

/** The real slot object plus a read used only when the server starts. */
export class LocalAccountJobQuota extends AccountJobQuota {
  /** Job ids holding a slot here, expired leases included. */
  async heldJobIds(): Promise<string[]> {
    return Object.keys((await this.ctx.storage.get<JobSlots>(SLOTS_KEY)) ?? {});
  }
}

interface LocalQuotaStub extends AccountJobQuotaStub {
  heldJobIds(): Promise<string[]>;
}

interface JobOwner {
  userId: string;
  command: string;
}

type RunJob = (spec: JobSpec, options: { signal: AbortSignal }) => Promise<unknown>;

/** What the server uses of container/local-executor.mjs. */
interface LocalExecutor {
  maxConcurrent: number;
  activeJobs(): number;
  accepting(): boolean;
  start(jobId: string, spec: JobSpec, userId: string, command?: string): Promise<JobView>;
  status(jobId: string): Promise<JobView | null>;
  ownerOf(jobId: string): Promise<JobOwner | null>;
  cancel(jobId: string): Promise<JobView | null>;
  close(): Promise<void>;
}

export interface LocalJobsOptions {
  /** Job records and the executor lock (`<MULTIX_DATA_DIR>/jobs`), mode 0700. */
  stateDir: string;
  /** MULTIX_LOCAL_MAX_CONCURRENT_JOBS. */
  maxConcurrent: number;
  /** The multix CLI: a name looked up on PATH or an absolute path. */
  cliBin?: string;
  /** How long close() waits for running CLI processes to exit. */
  closeTimeoutMs?: number;
  /** Injected in tests instead of job-runner.mjs `runJob`. */
  runJob?: RunJob;
}

export interface LocalJobs {
  readonly maxConcurrent: number;
  activeJobs(): number;
  accepting(): boolean;
  /** The MULTIX_JOBS binding. */
  readonly namespace: JobNamespace;
  /** Stop accepting jobs, record running ones as interrupted, wait for their final hooks. */
  close(): Promise<void>;
}

export const DEFAULT_CLI_BIN = "multix";

/** Absolute path of an executable `bin` (on PATH unless absolute); undefined when there is none. */
export async function resolveExecutable(
  bin: string,
  pathEnv: string | undefined = process.env.PATH,
): Promise<string | undefined> {
  const candidates = isAbsolute(bin)
    ? [bin]
    : bin.includes("/")
      ? []
      : (pathEnv ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, bin));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; try the next PATH entry.
    }
  }
  return undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/**
 * Start the executor and bind it. `env` must already hold MULTIX_JOB_QUOTA
 * (a LocalAccountJobQuota namespace) and may hold MULTIX_EVENTS.
 */
export async function startLocalJobs(
  env: WorkerEnv,
  options: LocalJobsOptions,
): Promise<LocalJobs> {
  const quotaNamespace = env.MULTIX_JOB_QUOTA;
  if (!quotaNamespace) throw new Error("MULTIX_JOB_QUOTA must be bound before jobs start");
  const quota = durableJobQuota(quotaNamespace);
  const cliBin = options.cliBin ?? DEFAULT_CLI_BIN;
  const run: RunJob =
    options.runJob ?? ((spec, { signal }) => runJob(spec, { signal, bin: cliBin }));
  /** Final hooks still running, awaited by close() so the database outlives them. */
  const finals = new Set<Promise<void>>();

  async function publish(owner: JobOwner, events: MultixEvent[]): Promise<void> {
    if (events.length === 0 || !env.MULTIX_EVENTS) return;
    await env.MULTIX_EVENTS.getByName(owner.userId).publish(events);
  }

  async function finalHook(jobId: string, view: JobView, owner: JobOwner): Promise<void> {
    try {
      await quota.release(owner.userId, jobId);
    } catch (error) {
      // The slot lease frees it later.
      logEvent("warn", "job_slot_release_failed", { job: jobId, error: errorName(error) });
    }
    try {
      await publish(owner, jobEvents({ jobId, command: owner.command }, view));
    } catch (error) {
      logEvent("warn", "job_events_publish_failed", { job: jobId, error: errorName(error) });
    }
  }

  const executor = (await createLocalExecutor({
    stateDir: options.stateDir,
    maxConcurrent: options.maxConcurrent,
    closeTimeoutMs: options.closeTimeoutMs,
    runJob: run as never,
    onFinal: (jobId: string, view: object, owner: JobOwner) => {
      const done = finalHook(jobId, view as JobView, owner);
      finals.add(done);
      done.finally(() => finals.delete(done));
      return done;
    },
  })) as unknown as LocalExecutor;

  // Final hooks of jobs the previous process left running are under way; any
  // other server slot is stale, since nothing of this executor runs yet.
  try {
    const server = quotaNamespace.getByName(SERVER_SLOTS_NAME) as LocalQuotaStub;
    let released = 0;
    for (const jobId of await server.heldJobIds()) {
      const owner = await executor.ownerOf(jobId);
      if (owner) await quota.release(owner.userId, jobId);
      // Unknown to the executor (stopped before its record was written): the account slot expires by lease.
      else await server.release(jobId);
      released++;
    }
    if (released > 0) logEvent("info", "job_slots_reconciled", { released });
  } catch (error) {
    logEvent("warn", "job_slots_reconcile_failed", { error: errorName(error) });
  }

  const stub = (jobId: string): JobContainerStub => ({
    startJob: (spec, userId, command) => executor.start(jobId, spec, userId, command ?? ""),
    jobStatus: () => executor.status(jobId),
    cancelJob: () => executor.cancel(jobId),
  });

  return {
    maxConcurrent: executor.maxConcurrent,
    activeJobs: () => executor.activeJobs(),
    accepting: () => executor.accepting(),
    namespace: { getByName: stub },
    async close() {
      await executor.close();
      // onFinal is called on a later microtask than the final write.
      await new Promise((resolve) => setImmediate(resolve));
      await Promise.allSettled([...finals]);
    },
  };
}
