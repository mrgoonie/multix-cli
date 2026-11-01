/**
 * Self-hosted job executor: runs multix jobs as child processes of the server
 * itself, for deployments without Cloudflare Containers (a single container on
 * TOSE/Kubernetes). It answers the same `start` / `status` / `cancel` calls as
 * the Worker's Durable Object backend (worker/src/jobs/job-store.ts
 * `JobBackend`) and returns the same job views (worker/src/jobs/job-protocol.ts).
 *
 * No HTTP server is involved: the job server (job-server.mjs) is not used, so
 * there is no job port to expose. Each job runs through `runJob` from
 * job-runner.mjs, which keeps its argv-only execFile, per-job temp directory,
 * input size, output size and timeout limits.
 *
 * Safety rules:
 *  - Concurrency cap (default 1): the slot is checked and taken synchronously,
 *    before anything is awaited and before the job runs, so two simultaneous
 *    starts can never both pass. A refused job never reaches a provider. A
 *    canceled job keeps its slot until its CLI process has exited.
 *  - Durable state: one JSON file per job in `stateDir`, written atomically
 *    (temporary file + rename, mode 0600). It holds the job view and its owner
 *    only; the spec with the caller's keys is never written anywhere.
 *  - A job reaches a final state once: the run finishing, cancel and shutdown
 *    can race, and only the first one is recorded.
 *  - Restart: a job that was still running when the server stopped is
 *    recorded as failed and `interrupted`, never run again, so a billed
 *    provider call is not repeated without the caller starting a new job.
 *  - One process per state directory: a lock file stops a second server
 *    process (another replica on a shared volume) from sharing the cap and
 *    from marking the first one's live jobs as interrupted.
 */

import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { runJob as defaultRunJob, validateSpec } from "./job-runner.mjs";

/** Same text as SERVER_AT_CAPACITY_ERROR in worker/src/jobs/job-protocol.ts. */
export const SERVER_AT_CAPACITY_ERROR =
  "server at capacity: every job container is in use; retry in a few minutes";
export const INTERRUPTED_ERROR =
  "The server stopped while the job was running. The job was not run again, so no provider call was repeated; start a new job to retry.";
export const CANCELED_ERROR = "Canceled by the caller";
/** Same as JOB_RETENTION_SECONDS in job-protocol.ts. */
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const LOCK_FILE = "executor.lock";
/** The lock holder touches the lock this often; a lock untouched for LOCK_STALE_MS is abandoned. */
export const LOCK_HEARTBEAT_MS = 15_000;
export const LOCK_STALE_MS = 60_000;

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL = new Set(["succeeded", "failed", "timed_out", "canceled"]);
/** State directories held by an executor in this process (the lock's pid check cannot tell them apart). */
const heldInProcess = new Set();

export class ExecutorLockedError extends Error {
  constructor() {
    super("Another multix server process is using this job state directory");
    this.name = "ExecutorLockedError";
  }
}

/** `MULTIX_LOCAL_MAX_CONCURRENT_JOBS`, an integer from 1 to 64; 1 when unset or invalid. */
export function maxConcurrentFromEnv(env = process.env) {
  const raw = env.MULTIX_LOCAL_MAX_CONCURRENT_JOBS;
  if (raw === undefined || raw === "") return 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 64) {
    throw new Error("MULTIX_LOCAL_MAX_CONCURRENT_JOBS must be an integer from 1 to 64");
  }
  return value;
}

function isTerminal(status) {
  return TERMINAL.has(status);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Write `data` to `file` so a reader sees either the old or the new content, never half of it. */
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

async function acquireLock(stateDir, now) {
  const file = join(resolve(stateDir), LOCK_FILE);
  if (heldInProcess.has(file)) throw new ExecutorLockedError();
  const mine = JSON.stringify({ pid: process.pid, host: hostname(), id: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, mine, { flag: "wx", mode: 0o600 });
      heldInProcess.add(file);
      return file;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let holder;
    let touchedAt = 0;
    try {
      holder = JSON.parse(await readFile(file, "utf8"));
      touchedAt = (await stat(file)).mtimeMs;
    } catch {
      holder = undefined;
    }
    const sameHost = holder?.host === hostname();
    // Same host: the holder is gone when its pid is dead, or when the pid is our own (a
    // restarted container reuses pid 1). Another host: only an untouched lock is abandoned.
    const abandoned = !holder
      ? true
      : sameHost
        ? holder.pid === process.pid || !pidAlive(holder.pid)
        : now() - touchedAt > LOCK_STALE_MS;
    if (!abandoned) throw new ExecutorLockedError();
    await rm(file, { force: true });
  }
  throw new ExecutorLockedError();
}

/**
 * @param {{
 *   stateDir: string,
 *   maxConcurrent?: number,
 *   retentionMs?: number,
 *   runJob?: (spec: object, options: { signal: AbortSignal }) => Promise<object>,
 *   now?: () => number,
 *   onFinal?: (jobId: string, view: object, owner: { userId: string, command: string }) => void,
 * }} options
 *   `runJob` is injected in tests; `onFinal` is told once about each job's final view
 *   (events, slot accounting), and its errors are ignored.
 */
export async function createLocalExecutor(options) {
  const { stateDir } = options;
  const maxConcurrent = options.maxConcurrent ?? 1;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("maxConcurrent must be a positive integer");
  }
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const run = options.runJob ?? defaultRunJob;
  const now = options.now ?? Date.now;

  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockFile = await acquireLock(stateDir, now);
  const heartbeat = setInterval(() => {
    const at = new Date(now());
    utimes(lockFile, at, at).catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();

  /** jobId -> { abort, done } for every job whose CLI may still be running; its size is the cap. */
  const running = new Map();
  /** Per-job chain that serializes read-modify-write of the job file. */
  const locks = new Map();
  let closed = false;

  const fileOf = (jobId) => join(stateDir, `${jobId}.json`);

  async function loadRecord(jobId) {
    try {
      const record = JSON.parse(await readFile(fileOf(jobId), "utf8"));
      return record && typeof record === "object" && record.view ? record : undefined;
    } catch {
      return undefined;
    }
  }

  function serialized(jobId, task) {
    const previous = locks.get(jobId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => {});
    locks.set(jobId, settled);
    settled.then(() => {
      if (locks.get(jobId) === settled) locks.delete(jobId);
    });
    return next;
  }

  /** Record a final state unless one is already recorded; returns the recorded view. */
  function finish(jobId, status, fields) {
    return serialized(jobId, async () => {
      const record = await loadRecord(jobId);
      if (!record) return undefined;
      if (isTerminal(record.view.status)) return record.view;
      const view = { status, createdAt: record.view.createdAt, finishedAt: now(), ...fields };
      await writeAtomic(fileOf(jobId), JSON.stringify({ ...record, view }));
      try {
        options.onFinal?.(jobId, view, record.owner);
      } catch {
        // A failing listener must not undo the recorded result.
      }
      return view;
    });
  }

  async function recover() {
    let names;
    try {
      names = await readdir(stateDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.endsWith(".tmp")) {
        // A write that never reached its rename; the job file itself is intact.
        await rm(join(stateDir, name), { force: true });
        continue;
      }
      const jobId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!JOB_ID_RE.test(jobId)) continue;
      const record = await loadRecord(jobId);
      if (!record) continue;
      if (!isTerminal(record.view.status)) {
        await finish(jobId, "failed", { error: INTERRUPTED_ERROR, interrupted: true });
      } else if (now() - (record.view.finishedAt ?? record.view.createdAt) > retentionMs) {
        // Only the job record expires; output files live in the caller's own bucket.
        await rm(fileOf(jobId), { force: true });
      }
    }
  }

  await recover();

  function resultToFinal(result) {
    const status = isTerminal(result?.status) ? result.status : "failed";
    const fields = { result: { ...result, status } };
    if (status !== "succeeded" && result?.error) fields.error = result.error;
    return { status, fields };
  }

  return {
    maxConcurrent,

    /** How many job slots are taken now (CLI processes that may still run). */
    activeJobs: () => running.size,

    async start(jobId, spec, userId, command = "") {
      if (closed)
        return { status: "failed", createdAt: now(), finishedAt: now(), error: INTERRUPTED_ERROR };
      if (!JOB_ID_RE.test(jobId) || spec?.jobId !== jobId) throw new Error("Invalid job id");
      if (typeof userId !== "string" || userId === "") throw new Error("Invalid owner");
      validateSpec(spec);
      // Synchronous check-and-take: nothing above awaits, so concurrent starts cannot both pass.
      if (running.has(jobId)) {
        return (await loadRecord(jobId))?.view ?? { status: "starting", createdAt: now() };
      }
      const atCapacity = running.size >= maxConcurrent;
      const slot = atCapacity ? undefined : { abort: new AbortController(), done: undefined };
      if (slot) running.set(jobId, slot);
      try {
        const existing = await loadRecord(jobId);
        if (existing) {
          if (slot) running.delete(jobId);
          return existing.view;
        }
        const createdAt = now();
        const owner = { userId, command: String(command) };
        if (!slot) {
          const view = {
            status: "failed",
            createdAt,
            finishedAt: createdAt,
            error: SERVER_AT_CAPACITY_ERROR,
          };
          await writeAtomic(fileOf(jobId), JSON.stringify({ owner, view }));
          try {
            options.onFinal?.(jobId, view, owner);
          } catch {}
          return view;
        }
        const view = { status: "running", createdAt };
        await writeAtomic(fileOf(jobId), JSON.stringify({ owner, view }));
        slot.done = Promise.resolve()
          .then(() => run(spec, { signal: slot.abort.signal }))
          .catch(() => ({
            status: "failed",
            exitCode: null,
            stdout: "",
            stderrTail: "",
            outputs: [],
            error: "The job failed inside the server",
          }))
          .then((result) => {
            const final = resultToFinal(result);
            return finish(jobId, final.status, final.fields);
          })
          .catch(() => undefined)
          .finally(() => running.delete(jobId));
        return view;
      } catch (error) {
        if (slot && !slot.done) running.delete(jobId);
        throw error;
      }
    },

    /** The stored view; null for an unknown job. */
    async status(jobId) {
      if (!JOB_ID_RE.test(jobId)) return null;
      return (await loadRecord(jobId))?.view ?? null;
    },

    /** The job's owner, for callers that keep no ownership record of their own. */
    async ownerOf(jobId) {
      if (!JOB_ID_RE.test(jobId)) return null;
      return (await loadRecord(jobId))?.owner ?? null;
    },

    /** Cancel a running job; the final view is recorded at once, the slot frees when the CLI exits. */
    async cancel(jobId) {
      if (!JOB_ID_RE.test(jobId)) return null;
      const record = await loadRecord(jobId);
      if (!record) return null;
      if (isTerminal(record.view.status)) return record.view;
      const view = await finish(jobId, "canceled", { error: CANCELED_ERROR });
      running.get(jobId)?.abort.abort();
      return view ?? null;
    },

    /**
     * Graceful stop (SIGTERM): running jobs are recorded as interrupted and
     * their CLI processes are stopped; waits for them to exit, then frees the lock.
     */
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      const live = [...running.entries()];
      for (const [jobId] of live) {
        await finish(jobId, "failed", { error: INTERRUPTED_ERROR, interrupted: true });
      }
      for (const [, slot] of live) slot.abort.abort();
      await Promise.all(live.map(([, slot]) => slot.done));
      await Promise.all([...locks.values()]);
      await rm(lockFile, { force: true });
      heldInProcess.delete(lockFile);
    },
  };
}
