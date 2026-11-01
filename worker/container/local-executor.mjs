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
 *  - One process per state directory: the executor listens on a Unix socket
 *    in `stateDir` (no network port) for as long as it runs. A second server
 *    process on the same host (a restarted or overlapping container sharing
 *    the volume) finds the socket answering and refuses to start, so it can
 *    neither share the cap nor mark the first one's live jobs as interrupted.
 *    The kernel decides liveness: a socket left by a crashed process refuses
 *    connections and is replaced at once, with no heartbeat or timeout.
 *    A Unix socket cannot be reached from another host, so replicas on
 *    different nodes sharing one volume (ReadWriteMany, NFS) are NOT
 *    detected: run one replica per volume (a ReadWriteOnce PVC). The socket
 *    path (`stateDir` + "/executor.sock") must fit in MAX_SOCKET_PATH_BYTES.
 */

import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
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
export const LOCK_SOCKET = "executor.sock";
const TAKEOVER_FILE = "executor.takeover";
/** A takeover marker older than this was left by a process that crashed mid-takeover. */
const TAKEOVER_STALE_MS = 5_000;
/** How long start-up keeps trying while another contender holds the takeover marker. */
const LOCK_DEADLINE_MS = TAKEOVER_STALE_MS + 3_000;
/** Linux `sun_path` is 108 bytes with its NUL; Node truncates a longer path silently. */
export const MAX_SOCKET_PATH_BYTES = 107;
/** How long close() waits for running CLI processes to exit after stopping them. */
export const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const FINAL_WRITE_ATTEMPTS = 3;

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Temporary file of a job record write (`<job id>.json.<pid>.<uuid>.tmp`). */
const JOB_TEMP_RE = /^[0-9a-f-]{36}\.json\.\d+\.[0-9a-f-]{36}\.tmp$/;
const TERMINAL = new Set(["succeeded", "failed", "timed_out", "canceled"]);

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
  await syncDir(dirname(file));
}

/** Create `file` with `data` only when it does not exist yet; false when it already exists. */
async function createExclusive(file, data) {
  const tmp = await writeTemp(file, data);
  try {
    await link(tmp, file);
    await syncDir(dirname(file));
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(tmp, { force: true });
  }
}

/** "live" when a process accepts connections on the socket, "dead" when none does. */
function probeSocket(path) {
  return new Promise((resolveProbe, reject) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolveProbe("live");
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error?.code === "ECONNREFUSED" || error?.code === "ENOENT") resolveProbe("dead");
      else reject(error);
    });
  });
}

function listenOn(path) {
  return new Promise((resolveListen, reject) => {
    // Contenders only probe: accept and drop their connections.
    const server = createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      server.unref();
      resolveListen(server);
    });
  });
}

/**
 * Hold `stateDir` by listening on its socket. A socket file nobody answers on
 * is removed, but only under the takeover marker (created exclusively) and
 * after probing again, so a socket another contender has just bound is never
 * removed. After the removal any contender may bind; the first one wins and
 * the others find it answering.
 */
async function acquireLock(stateDir) {
  const path = join(stateDir, LOCK_SOCKET);
  const marker = join(stateDir, TAKEOVER_FILE);
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `The job state directory path is too long for its lock socket (at most ${MAX_SOCKET_PATH_BYTES - LOCK_SOCKET.length - 1} bytes); use a shorter path`,
    );
  }
  const giveUpAt = Date.now() + LOCK_DEADLINE_MS;
  while (Date.now() < giveUpAt) {
    try {
      return { path, server: await listenOn(path) };
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
    if ((await probeSocket(path)) === "live") throw new ExecutorLockedError();
    let marked = false;
    try {
      await open(marker, "wx", 0o600).then((handle) => handle.close());
      marked = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const age = await stat(marker).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > TAKEOVER_STALE_MS) await rm(marker, { force: true });
    }
    if (marked) {
      try {
        if ((await probeSocket(path)) === "dead") await rm(path, { force: true });
      } finally {
        await rm(marker, { force: true });
      }
    } else {
      await sleep(20 + Math.floor(Math.random() * 30));
    }
  }
  throw new ExecutorLockedError();
}

/**
 * @param {{
 *   stateDir: string,
 *   maxConcurrent?: number,
 *   retentionMs?: number,
 *   closeTimeoutMs?: number,
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
  const lock = await acquireLock(stateDir);

  /** jobId -> { abort, done } for every job whose CLI may still be running; its size is the cap. */
  const running = new Map();
  /** start() calls between their slot check and their hand-over, awaited by close(). */
  const inflight = new Set();
  /** Per-job chain that serializes read-modify-write of the job file. */
  const fileLocks = new Map();
  let closed = false;
  let closing;
  /** Final views whose write failed even after retries: served until a restart records the job as interrupted. */
  const unsaved = new Map();

  const fileOf = (jobId) => join(stateDir, `${jobId}.json`);

  function notifyFinal(jobId, view, owner) {
    if (!options.onFinal) return;
    Promise.resolve()
      .then(() => options.onFinal(jobId, view, owner))
      .catch(() => {});
  }

  async function loadRecord(jobId) {
    if (unsaved.has(jobId)) return unsaved.get(jobId);
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
  function finish(jobId, status, fields, { keepInMemory = false } = {}) {
    return serialized(jobId, async () => {
      const record = await loadRecord(jobId);
      if (!record) return undefined;
      if (isTerminal(record.view.status)) return record.view;
      const view = { status, createdAt: record.view.createdAt, finishedAt: now(), ...fields };
      try {
        await writeAtomic(fileOf(jobId), JSON.stringify({ ...record, view }));
      } catch (error) {
        if (!keepInMemory) throw error;
        // The disk refuses the write: answer the final view from memory. The file still says
        // running, so a restart records the job as interrupted; it is never run again.
        unsaved.set(jobId, { ...record, view });
      }
      notifyFinal(jobId, view, record.owner);
      return view;
    });
  }

  /** finish() with retries, for paths that have no caller to report a failed write to. */
  async function finishWithRetry(jobId, status, fields) {
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= FINAL_WRITE_ATTEMPTS;
      try {
        return await finish(jobId, status, fields, { keepInMemory: last });
      } catch {
        if (last) return undefined;
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
        // A job write that never reached its rename; the job file itself is intact.
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
    await new Promise((r) => lock.server.close(r));
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
    if (closed) return refusedView(SERVER_AT_CAPACITY_ERROR);
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
    if (closed || slot.abort.signal.aborted) {
      // close() or cancel() came while the record was written: do not start a provider call now.
      running.delete(jobId);
      const final = closed
        ? { status: "failed", fields: { error: INTERRUPTED_ERROR, interrupted: true } }
        : { status: "canceled", fields: { error: CANCELED_ERROR } };
      return (await finishWithRetry(jobId, final.status, final.fields)) ?? view;
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

    /** False once close() has been called. */
    accepting: () => !closed,

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
      if (!record) {
        // Started but its record is still being written: start() sees the abort and records it.
        const slot = running.get(jobId);
        if (!slot) return null;
        slot.abort.abort();
        return { status: "canceled", createdAt: now(), finishedAt: now(), error: CANCELED_ERROR };
      }
      if (isTerminal(record.view.status)) return record.view;
      const view = await finish(jobId, "canceled", { error: CANCELED_ERROR });
      running.get(jobId)?.abort.abort();
      return view ?? null;
    },

    /**
     * Graceful stop (SIGTERM): no new job starts, running jobs are recorded
     * as interrupted and their CLI processes are stopped; waits up to
     * `closeTimeoutMs` for them to exit, then releases the state directory.
     * Every call returns the same promise.
     */
    close() {
      closing ??= shutdown();
      return closing;
    },
  };

  async function shutdown() {
    closed = true;
    clearInterval(pruner);
    await Promise.allSettled([...inflight]);
    const live = [...running.entries()];
    // In parallel: on a failing disk each one retries for a while, and the grace period is short.
    await Promise.allSettled(
      live.map(([jobId]) =>
        finishWithRetry(jobId, "failed", { error: INTERRUPTED_ERROR, interrupted: true }),
      ),
    );
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
    // Closing the server removes the socket file.
    await new Promise((r) => lock.server.close(r));
  }
}
