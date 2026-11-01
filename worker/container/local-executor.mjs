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
 *  - Concurrency cap (default 1): the slot is checked and taken in one
 *    synchronous step, before the job runs, so two simultaneous starts can
 *    never both pass. A refused job never reaches a provider. A canceled job
 *    keeps its slot until its CLI process has exited.
 *  - Durable state: one JSON file per job in `stateDir`, written atomically
 *    (temporary file + rename, mode 0600). It holds the job view and its owner
 *    only; the spec with the caller's keys is never written anywhere.
 *  - A job reaches a final state once: the run finishing, cancel and shutdown
 *    can race, and only the first one is recorded.
 *  - Restart: a job that was still running when the server stopped is
 *    recorded as failed and `interrupted`, never run again, so a billed
 *    provider call is not repeated without the caller starting a new job.
 *  - One process per state directory: a lock file, created complete in one
 *    step and touched every LOCK_HEARTBEAT_MS, keeps a second server process
 *    (another replica on a shared volume) from sharing the cap and from
 *    marking the first one's live jobs as interrupted. A lock is taken over
 *    only once it has gone untouched for LOCK_STALE_MS, so a server that
 *    crashed without removing it delays the next start by up to that long.
 *    A holder that finds its lock replaced stops accepting jobs.
 */

import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { runJob as defaultRunJob, validateSpec } from "./job-runner.mjs";

/** Same text as SERVER_AT_CAPACITY_ERROR in worker/src/jobs/job-protocol.ts. */
export const SERVER_AT_CAPACITY_ERROR =
  "server at capacity: every job container is in use; retry in a few minutes";
export const INTERRUPTED_ERROR =
  "The server stopped while the job was running. The job was not run again, so no provider call was repeated; start a new job to retry.";
export const CANCELED_ERROR = "Canceled by the caller";
export const RUNNER_FAILED_ERROR = "The job failed inside the server";
/** Same as JOB_RETENTION_SECONDS in job-protocol.ts. */
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const LOCK_FILE = "executor.lock";
/** The lock holder touches the lock this often; a lock untouched for LOCK_STALE_MS is abandoned. */
export const LOCK_HEARTBEAT_MS = 15_000;
export const LOCK_STALE_MS = 60_000;
/** How long start-up waits for an abandoned lock to become stale before giving up. */
export const DEFAULT_LOCK_WAIT_MS = LOCK_STALE_MS + LOCK_HEARTBEAT_MS;
/** How long close() waits for running CLI processes to exit after stopping them. */
export const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const FINAL_WRITE_ATTEMPTS = 3;

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Temporary file of a job record write (`<job id>.json.<pid>.<uuid>.tmp`). */
const JOB_TEMP_RE = /^[0-9a-f-]{36}\.json\.\d+\.[0-9a-f-]{36}\.tmp$/;
const TERMINAL = new Set(["succeeded", "failed", "timed_out", "canceled"]);
/** Lock files held by an executor in this process. */
const heldInProcess = new Set();

export class ExecutorLockedError extends Error {
  constructor() {
    super("Another multix server process is using this job state directory");
    this.name = "ExecutorLockedError";
  }
}

/** `MULTIX_LOCAL_MAX_CONCURRENT_JOBS`, an integer from 1 to 64; 1 when unset. */
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function syncDir(dir) {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not every file system allows fsync on a directory.
  }
}

/** Write a complete temporary file next to `file`; returns its path. */
async function writeTemp(file, data) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return tmp;
}

/** Write `data` to `file` so a reader sees either the old or the new content, never half of it. */
async function writeAtomic(file, data) {
  const tmp = await writeTemp(file, data);
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Create `file` with `data` only when it does not exist yet; false when it already exists. */
async function createExclusive(file, data) {
  const tmp = await writeTemp(file, data);
  try {
    await link(tmp, file);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(tmp, { force: true });
  }
}

async function readLockId(file) {
  try {
    return JSON.parse(await readFile(file, "utf8")).id;
  } catch {
    return undefined;
  }
}

/**
 * Create the lock with its full content in one step (`link` fails when the
 * name exists), so no reader ever sees an empty or partial lock. A lock held
 * by someone else is taken over only after it has gone untouched for
 * LOCK_STALE_MS; until then start-up waits, up to `waitMs`.
 */
async function acquireLock(stateDir, { now, waitMs, pollMs }) {
  const file = join(stateDir, LOCK_FILE);
  if (heldInProcess.has(file)) throw new ExecutorLockedError();
  const id = randomUUID();
  const tmp = await writeTemp(file, JSON.stringify({ id, pid: process.pid, at: now() }));
  const giveUpAt = now() + waitMs;
  try {
    for (;;) {
      try {
        await link(tmp, file);
        heldInProcess.add(file);
        await syncDir(stateDir);
        return { file, id };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      let touchedAt;
      try {
        touchedAt = (await stat(file)).mtimeMs;
      } catch {
        continue; // Removed meanwhile: try to create it again.
      }
      if (now() - touchedAt > LOCK_STALE_MS) {
        const staleId = await readLockId(file);
        const tomb = `${file}.${randomUUID()}.stale`;
        try {
          await rename(file, tomb);
        } catch {
          continue; // Someone else moved it first.
        }
        if ((await readLockId(tomb)) !== staleId) {
          // A contender replaced the stale lock between our read and our rename: give it back.
          await link(tomb, file).catch(() => {});
          await rm(tomb, { force: true });
          throw new ExecutorLockedError();
        }
        await rm(tomb, { force: true });
        continue;
      }
      if (now() >= giveUpAt) throw new ExecutorLockedError();
      await sleep(pollMs);
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * @param {{
 *   stateDir: string,
 *   maxConcurrent?: number,
 *   retentionMs?: number,
 *   lockWaitMs?: number,
 *   lockPollMs?: number,
 *   closeTimeoutMs?: number,
 *   lockHeartbeatMs?: number,
 *   runJob?: (spec: object, options: { signal: AbortSignal }) => Promise<object>,
 *   now?: () => number,
 *   onFinal?: (jobId: string, view: object, owner: { userId: string, command: string }) => unknown,
 * }} options
 *   `runJob` is injected in tests; `onFinal` is told once about each job's final view
 *   (events, slot accounting); its errors, sync or async, are ignored.
 */
export async function createLocalExecutor(options) {
  const stateDir = resolve(options.stateDir);
  const maxConcurrent = options.maxConcurrent ?? 1;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("maxConcurrent must be a positive integer");
  }
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const run = options.runJob ?? defaultRunJob;
  const now = options.now ?? Date.now;

  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700).catch(() => {});
  const lock = await acquireLock(stateDir, {
    now,
    waitMs: options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS,
    pollMs: options.lockPollMs ?? 1000,
  });

  /** jobId -> { abort, done } for every job whose CLI may still be running; its size is the cap. */
  const running = new Map();
  /** start() calls between their slot check and their hand-over, awaited by close(). */
  const inflight = new Set();
  /** Per-job chain that serializes read-modify-write of the job file. */
  const fileLocks = new Map();
  let closed = false;
  let lockLost = false;

  const heartbeat = setInterval(async () => {
    if ((await readLockId(lock.file)) !== lock.id) {
      // Taken over (this process stalled past LOCK_STALE_MS): stop accepting jobs.
      lockLost = true;
      clearInterval(heartbeat);
      return;
    }
    const at = new Date(now());
    await utimes(lock.file, at, at).catch(() => {});
  }, options.lockHeartbeatMs ?? LOCK_HEARTBEAT_MS);
  heartbeat.unref();

  const fileOf = (jobId) => join(stateDir, `${jobId}.json`);

  function notifyFinal(jobId, view, owner) {
    if (!options.onFinal) return;
    Promise.resolve()
      .then(() => options.onFinal(jobId, view, owner))
      .catch(() => {});
  }

  async function loadRecord(jobId) {
    try {
      const record = JSON.parse(await readFile(fileOf(jobId), "utf8"));
      return record && typeof record === "object" && record.view ? record : undefined;
    } catch {
      return undefined;
    }
  }

  function serialized(jobId, task) {
    const previous = fileLocks.get(jobId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => {});
    fileLocks.set(jobId, settled);
    settled.then(() => {
      if (fileLocks.get(jobId) === settled) fileLocks.delete(jobId);
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
      notifyFinal(jobId, view, record.owner);
      return view;
    });
  }

  /** finish() with retries, for paths that have no caller to report a failed write to. */
  async function finishWithRetry(jobId, status, fields) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await finish(jobId, status, fields);
      } catch {
        // Left as running, the job is recorded as interrupted on the next start-up.
        if (attempt >= FINAL_WRITE_ATTEMPTS) return undefined;
        await sleep(250 * attempt);
      }
    }
  }

  async function sweep({ recover }) {
    let names;
    try {
      names = await readdir(stateDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (recover && JOB_TEMP_RE.test(name)) {
        // A job write that never reached its rename; the job file itself is intact. Lock
        // files (temporary or stale) are left alone: other processes may be using them.
        await rm(join(stateDir, name), { force: true });
        continue;
      }
      const jobId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!JOB_ID_RE.test(jobId)) continue;
      const record = await loadRecord(jobId);
      if (!record) continue;
      if (!isTerminal(record.view.status)) {
        if (recover) await finish(jobId, "failed", { error: INTERRUPTED_ERROR, interrupted: true });
      } else if (now() - (record.view.finishedAt ?? record.view.createdAt) > retentionMs) {
        // Only the job record expires; output files live in the caller's own bucket.
        await rm(fileOf(jobId), { force: true });
      }
    }
  }

  try {
    await sweep({ recover: true });
  } catch (error) {
    clearInterval(heartbeat);
    heldInProcess.delete(lock.file);
    if ((await readLockId(lock.file)) === lock.id) await rm(lock.file, { force: true });
    throw error;
  }
  const pruner = setInterval(() => {
    sweep({ recover: false }).catch(() => {});
  }, PRUNE_INTERVAL_MS);
  pruner.unref();

  function resultToFinal(result) {
    const status = isTerminal(result?.status) ? result.status : "failed";
    const fields = { result: { ...result, status } };
    if (status !== "succeeded" && result?.error) fields.error = result.error;
    return { status, fields };
  }

  const refusedView = (error) => ({ status: "failed", createdAt: now(), finishedAt: now(), error });

  async function startJob(jobId, spec, userId, command) {
    const existing = await loadRecord(jobId);
    if (existing) return existing.view;
    if (closed || lockLost) return refusedView(SERVER_AT_CAPACITY_ERROR);
    // Check and take the slot in one synchronous step: no await between them.
    if (running.has(jobId)) return { status: "starting", createdAt: now() };
    const owner = { userId, command: String(command) };
    if (running.size >= maxConcurrent) {
      const view = refusedView(SERVER_AT_CAPACITY_ERROR);
      if (!(await createExclusive(fileOf(jobId), JSON.stringify({ owner, view })))) {
        return (await loadRecord(jobId))?.view ?? view;
      }
      notifyFinal(jobId, view, owner);
      return view;
    }
    const slot = { abort: new AbortController(), done: undefined };
    running.set(jobId, slot);
    const view = { status: "running", createdAt: now() };
    try {
      // Exclusive create: a start of the same job id that finished meanwhile keeps its record.
      if (!(await createExclusive(fileOf(jobId), JSON.stringify({ owner, view })))) {
        running.delete(jobId);
        return (await loadRecord(jobId))?.view ?? view;
      }
    } catch (error) {
      running.delete(jobId);
      throw error;
    }
    if (closed || lockLost) {
      // close() began while the record was written: do not start a provider call now.
      running.delete(jobId);
      return (
        (await finishWithRetry(jobId, "failed", { error: INTERRUPTED_ERROR, interrupted: true })) ??
        view
      );
    }
    slot.done = Promise.resolve()
      .then(() => run(spec, { signal: slot.abort.signal }))
      .catch(() => ({
        status: "failed",
        exitCode: null,
        stdout: "",
        stderrTail: "",
        outputs: [],
        error: RUNNER_FAILED_ERROR,
      }))
      .then((result) => {
        const final = resultToFinal(result);
        return finishWithRetry(jobId, final.status, final.fields);
      })
      .finally(() => running.delete(jobId));
    return view;
  }

  return {
    maxConcurrent,

    /** How many job slots are taken now (CLI processes that may still run). */
    activeJobs: () => running.size,

    /** False once close() ran or another process took the state directory over. */
    accepting: () => !closed && !lockLost,

    async start(jobId, spec, userId, command = "") {
      if (!JOB_ID_RE.test(jobId) || spec?.jobId !== jobId) throw new Error("Invalid job id");
      if (typeof userId !== "string" || userId === "") throw new Error("Invalid owner");
      validateSpec(spec);
      const pending = startJob(jobId, spec, userId, command);
      inflight.add(pending);
      try {
        return await pending;
      } finally {
        inflight.delete(pending);
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
     * Graceful stop (SIGTERM): no new job starts, running jobs are recorded
     * as interrupted and their CLI processes are stopped; waits up to
     * `closeTimeoutMs` for them to exit, then frees the lock if it is still ours.
     */
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(pruner);
      await Promise.allSettled([...inflight]);
      const live = [...running.entries()];
      for (const [jobId] of live) {
        await finishWithRetry(jobId, "failed", { error: INTERRUPTED_ERROR, interrupted: true });
      }
      for (const [, slot] of live) slot.abort.abort();
      let timer;
      await Promise.race([
        Promise.allSettled(live.map(([, slot]) => slot.done)),
        new Promise((r) => {
          timer = setTimeout(r, closeTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      await Promise.allSettled([...fileLocks.values()]);
      if ((await readLockId(lock.file)) === lock.id) await rm(lock.file, { force: true });
      heldInProcess.delete(lock.file);
    },
  };
}
