/**
 * The self-hosted local executor (container/local-executor.mjs): concurrency
 * cap, durable state without secrets, cancel races, restart recovery and the
 * state-directory lock. Jobs run through an injected runJob, plus one run of
 * the real job runner against the fake `multix` binary. No network, no provider.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: untyped .mjs modules
type Any = any;
const testFileUrl = (import.meta as unknown as { url: string }).url;
const local = (rel: string) => decodeURIComponent(new URL(rel, testFileUrl).pathname);
const load = (rel: string): Promise<Any> => import(/* @vite-ignore */ local(rel));
const mod = () => load("../container/local-executor.mjs");

const FAKE_BIN = local("./fixtures/fake-multix.mjs");
const KEY = "AIza-gemini-secret-value-1234";
const ID1 = "11111111-2222-4333-8444-555555555555";
const ID2 = "22222222-2222-4333-8444-555555555555";
const ID3 = "33333333-2222-4333-8444-555555555555";

function spec(jobId: string, argv = ["media", "optimize"]) {
  return { jobId, argv, env: { GEMINI_API_KEY: KEY }, inputs: [], timeoutMs: 20_000 };
}

const RESULT = { status: "succeeded", exitCode: 0, stdout: "ok", stderrTail: "", outputs: [] };

/** A runJob whose jobs finish only when the test says so; counts calls and sees abort signals. */
function controlledRun() {
  const calls: { spec: Any; signal: AbortSignal; finish: (r: Any) => void }[] = [];
  const runJob = (s: Any, o: { signal: AbortSignal }) =>
    new Promise((resolve) => calls.push({ spec: s, signal: o.signal, finish: resolve }));
  const first = () => {
    const call = calls[0];
    if (!call) throw new Error("no job ran");
    return call;
  };
  return { calls, runJob, first };
}

const dirs: string[] = [];
const executors: Any[] = [];
async function stateDir() {
  const dir = await mkdtemp(join(tmpdir(), "multix-exec-test-"));
  dirs.push(dir);
  return dir;
}
async function create(options: Any) {
  const { createLocalExecutor } = await mod();
  // Short waits so lock and shutdown paths finish within a test.
  const executor = await createLocalExecutor({
    lockWaitMs: 100,
    lockPollMs: 10,
    closeTimeoutMs: 200,
    ...options,
  });
  executors.push(executor);
  return executor;
}
const tick = () => new Promise((r) => setTimeout(r, 10));
async function until(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await tick();
  }
  throw new Error("condition not reached");
}

afterEach(async () => {
  for (const executor of executors.splice(0)) {
    // close() gives controlled jobs that never finish at most closeTimeoutMs.
    await executor.close();
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("local executor", () => {
  it("runs a job, records its final view once and never stores the spec or keys", async () => {
    const dir = await stateDir();
    const run = controlledRun();
    const finals: Any[] = [];
    const ex = await create({
      stateDir: dir,
      runJob: run.runJob,
      onFinal: (id: string, view: Any, owner: Any) => finals.push({ id, view, owner }),
    });
    const started = await ex.start(ID1, spec(ID1), "user-a", "image generate");
    expect(started.status).toBe("running");
    await until(() => run.calls.length === 1);
    expect(await ex.status(ID1)).toMatchObject({ status: "running" });
    run.first().finish(RESULT);
    await until(async () => (await ex.status(ID1))?.status === "succeeded");
    expect(ex.activeJobs()).toBe(0);
    expect(finals).toEqual([
      expect.objectContaining({ id: ID1, owner: { userId: "user-a", command: "image generate" } }),
    ]);
    expect(await ex.ownerOf(ID1)).toEqual({ userId: "user-a", command: "image generate" });
    const stored = await readFile(join(dir, `${ID1}.json`), "utf8");
    expect(stored).not.toContain(KEY);
    expect(stored).not.toContain("argv");
    // A repeated start of the same job returns the record; nothing runs again.
    expect((await ex.start(ID1, spec(ID1), "user-a")).status).toBe("succeeded");
    expect(run.calls).toHaveLength(1);
  });

  it("refuses a second simultaneous job before it runs, with the default cap of 1", async () => {
    const run = controlledRun();
    const ex = await create({ stateDir: await stateDir(), runJob: run.runJob });
    expect(ex.maxConcurrent).toBe(1);
    const [a, b] = await Promise.all([
      ex.start(ID1, spec(ID1), "user-a"),
      ex.start(ID2, spec(ID2), "user-b"),
    ]);
    const { SERVER_AT_CAPACITY_ERROR } = await mod();
    expect([a.status, b.status].sort()).toEqual(["failed", "running"]);
    expect([a, b].find((v: Any) => v.status === "failed").error).toBe(SERVER_AT_CAPACITY_ERROR);
    await until(() => run.calls.length === 1);
    await tick();
    expect(run.calls).toHaveLength(1);
    // The refusal is recorded, so polling the refused job answers the same error.
    const refusedId = a.status === "failed" ? ID1 : ID2;
    expect(await ex.status(refusedId)).toMatchObject({
      status: "failed",
      error: SERVER_AT_CAPACITY_ERROR,
    });
  });

  it("honours a higher cap", async () => {
    const run = controlledRun();
    const ex = await create({ stateDir: await stateDir(), runJob: run.runJob, maxConcurrent: 2 });
    const views = await Promise.all([ID1, ID2, ID3].map((id) => ex.start(id, spec(id), "u")));
    expect(views.map((v: Any) => v.status).sort()).toEqual(["failed", "running", "running"]);
    await until(() => run.calls.length === 2);
  });

  it("cancel is final and idempotent, and keeps the slot until the CLI has exited", async () => {
    const run = controlledRun();
    const ex = await create({ stateDir: await stateDir(), runJob: run.runJob });
    await ex.start(ID1, spec(ID1), "u");
    await until(() => run.calls.length === 1);
    const [c1, c2] = await Promise.all([ex.cancel(ID1), ex.cancel(ID1)]);
    expect(c1.status).toBe("canceled");
    expect(c2).toEqual(c1);
    expect(run.first().signal.aborted).toBe(true);
    // The CLI has not exited yet: the slot is still taken.
    expect((await ex.start(ID2, spec(ID2), "u")).status).toBe("failed");
    // A result arriving after the cancel does not replace it.
    run.first().finish(RESULT);
    await until(() => ex.activeJobs() === 0);
    expect((await ex.status(ID1)).status).toBe("canceled");
    expect((await ex.start(ID3, spec(ID3), "u")).status).toBe("running");
  });

  it("records a crashed runner as failed with a fixed message", async () => {
    const ex = await create({
      stateDir: await stateDir(),
      runJob: async () => {
        throw new Error(`boom ${KEY}`);
      },
    });
    await ex.start(ID1, spec(ID1), "u");
    await until(async () => (await ex.status(ID1))?.status === "failed");
    const view = await ex.status(ID1);
    expect(JSON.stringify(view)).not.toContain(KEY);
    const { RUNNER_FAILED_ERROR } = await mod();
    expect(view.error).toBe(RUNNER_FAILED_ERROR);
  });

  it("marks jobs left running by a dead server as interrupted and never runs them again", async () => {
    const dir = await stateDir();
    // What a server killed mid-job leaves behind: a running record, a lock of a dead pid, a torn write.
    await writeFile(
      join(dir, `${ID1}.json`),
      JSON.stringify({
        owner: { userId: "u", command: "video generate" },
        view: { status: "running", createdAt: 1 },
      }),
    );
    await writeFile(join(dir, `${ID2}.json.123.${ID3}.tmp`), "{");
    // Another process's lock attempt in progress: not ours to remove.
    await writeFile(join(dir, `executor.lock.456.${ID3}.tmp`), "{}");
    await writeFile(join(dir, "executor.lock"), JSON.stringify({ id: "dead-server" }));
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(join(dir, "executor.lock"), old, old);
    const run = controlledRun();
    const finals: Any[] = [];
    const ex = await create({
      stateDir: dir,
      runJob: run.runJob,
      onFinal: (id: string) => finals.push(id),
    });
    const { INTERRUPTED_ERROR } = await mod();
    expect(await ex.status(ID1)).toMatchObject({
      status: "failed",
      interrupted: true,
      error: INTERRUPTED_ERROR,
    });
    expect(finals).toEqual([ID1]);
    expect(run.calls).toHaveLength(0);
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([
      `executor.lock.456.${ID3}.tmp`,
    ]);
  });

  it("close() records running jobs as interrupted, stops them and frees the lock", async () => {
    const dir = await stateDir();
    const run = controlledRun();
    const ex = await create({ stateDir: dir, runJob: run.runJob });
    await ex.start(ID1, spec(ID1), "u");
    await until(() => run.calls.length === 1);
    run
      .first()
      .signal.addEventListener("abort", () =>
        run.first().finish({ ...RESULT, status: "canceled" }),
      );
    await ex.close();
    expect(await readdir(dir)).not.toContain("executor.lock");
    const record = JSON.parse(await readFile(join(dir, `${ID1}.json`), "utf8"));
    expect(record.view).toMatchObject({ status: "failed", interrupted: true });
    // A new server on the same volume starts cleanly and keeps the record.
    const next = await create({ stateDir: dir, runJob: run.runJob });
    expect((await next.status(ID1)).interrupted).toBe(true);
  });

  it("refuses a state directory another live server holds and takes over an abandoned one", async () => {
    const { ExecutorLockedError } = await mod();
    const dir = await stateDir();
    const run = controlledRun();
    await create({ stateDir: dir, runJob: run.runJob });
    // The same process cannot open it twice.
    await expect(create({ stateDir: dir, runJob: run.runJob })).rejects.toBeInstanceOf(
      ExecutorLockedError,
    );

    const other = await stateDir();
    const lock = join(other, "executor.lock");
    // A fresh lock is never taken over, even one naming our own pid (pid 1 in every container).
    await writeFile(lock, JSON.stringify({ id: "live", pid: process.pid }));
    await expect(create({ stateDir: other, runJob: run.runJob })).rejects.toBeInstanceOf(
      ExecutorLockedError,
    );
    // An empty lock (never written by this module, which creates it complete) is not abandoned either.
    await writeFile(lock, "");
    await expect(create({ stateDir: other, runJob: run.runJob })).rejects.toBeInstanceOf(
      ExecutorLockedError,
    );
    // The same lock after its heartbeat stopped.
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(lock, old, old);
    const ex = await create({ stateDir: other, runJob: run.runJob });
    expect(ex.accepting()).toBe(true);
    expect(JSON.parse(await readFile(lock, "utf8")).id).not.toBe("live");
    expect((await readdir(other)).filter((n) => n !== "executor.lock")).toEqual([]);
  });

  it("waits for a lock that is released during start-up", async () => {
    const dir = await stateDir();
    const lock = join(dir, "executor.lock");
    await writeFile(lock, JSON.stringify({ id: "stopping" }));
    setTimeout(() => {
      rm(lock, { force: true });
    }, 50);
    const ex = await create({ stateDir: dir, runJob: controlledRun().runJob, lockWaitMs: 2000 });
    expect(ex.accepting()).toBe(true);
  });

  it("lets exactly one of several processes starting together hold the directory", async () => {
    const dir = await stateDir();
    const script = local("./fixtures/lock-contender.mjs");
    const moduleUrl = new URL("../container/local-executor.mjs", testFileUrl).href;
    for (let round = 0; round < 5; round++) {
      const results = await Promise.all(
        [0, 1, 2, 3].map(
          () =>
            new Promise<string>((resolve, reject) => {
              execFile(process.execPath, [script, moduleUrl, dir], (error, stdout) =>
                error ? reject(error) : resolve(stdout.trim()),
              );
            }),
        ),
      );
      expect(results.sort()).toEqual(["held", "locked", "locked", "locked"]);
    }
  });

  it("stops accepting jobs when another process took its lock over", async () => {
    const dir = await stateDir();
    const run = controlledRun();
    const ex = await create({ stateDir: dir, runJob: run.runJob, lockHeartbeatMs: 20 });
    await writeFile(join(dir, "executor.lock"), JSON.stringify({ id: "new-owner" }));
    await until(() => !ex.accepting());
    const { SERVER_AT_CAPACITY_ERROR } = await mod();
    expect(await ex.start(ID1, spec(ID1), "u")).toMatchObject({
      status: "failed",
      error: SERVER_AT_CAPACITY_ERROR,
    });
    expect(run.calls).toHaveLength(0);
    await ex.close();
    // The new owner's lock is left alone.
    expect(JSON.parse(await readFile(join(dir, "executor.lock"), "utf8")).id).toBe("new-owner");
  });

  it("does not start a job whose start raced with close()", async () => {
    const dir = await stateDir();
    const run = controlledRun();
    const ex = await create({ stateDir: dir, runJob: run.runJob });
    const starting = ex.start(ID1, spec(ID1), "u");
    await ex.close();
    expect((await starting).status).toBe("failed");
    await tick();
    expect(run.calls).toHaveLength(0);
    expect(await readdir(dir)).not.toContain("executor.lock");
  });

  it("ignores an async onFinal that rejects", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const run = controlledRun();
      const ex = await create({
        stateDir: await stateDir(),
        runJob: run.runJob,
        onFinal: async () => {
          throw new Error("listener down");
        },
      });
      await ex.start(ID1, spec(ID1), "u");
      await until(() => run.calls.length === 1);
      run.first().finish(RESULT);
      await until(async () => (await ex.status(ID1))?.status === "succeeded");
      await tick();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps a finished job's record when the same job id is started again concurrently", async () => {
    const run = controlledRun();
    const ex = await create({ stateDir: await stateDir(), runJob: run.runJob, maxConcurrent: 2 });
    await ex.start(ID1, spec(ID1), "u");
    await until(() => run.calls.length === 1);
    run.first().finish(RESULT);
    await until(() => ex.activeJobs() === 0);
    const again = await Promise.all([ex.start(ID1, spec(ID1), "u"), ex.start(ID1, spec(ID1), "u")]);
    expect(again.map((v: Any) => v.status)).toEqual(["succeeded", "succeeded"]);
    expect(run.calls).toHaveLength(1);
  });

  it("rejects job ids that are not UUIDs and specs that do not validate", async () => {
    const run = controlledRun();
    const ex = await create({ stateDir: await stateDir(), runJob: run.runJob });
    await expect(ex.start("../../etc/x", spec("../../etc/x"), "u")).rejects.toThrow();
    await expect(ex.start(ID1, spec(ID2), "u")).rejects.toThrow();
    await expect(ex.start(ID1, { ...spec(ID1), env: { PATH: "/tmp" } }, "u")).rejects.toThrow();
    await expect(ex.start(ID1, spec(ID1), "")).rejects.toThrow();
    expect(await ex.status("../../etc/passwd")).toBeNull();
    expect(await ex.cancel("../x")).toBeNull();
    expect(await ex.status(ID3)).toBeNull();
    expect(run.calls).toHaveLength(0);
    expect(ex.activeJobs()).toBe(0);
  });

  it("drops job records past the retention period on start-up", async () => {
    const dir = await stateDir();
    const view = (finishedAt: number) =>
      JSON.stringify({
        owner: { userId: "u", command: "" },
        view: { status: "succeeded", createdAt: finishedAt, finishedAt },
      });
    await writeFile(join(dir, `${ID1}.json`), view(Date.now() - 8 * 24 * 3600_000));
    await writeFile(join(dir, `${ID2}.json`), view(Date.now() - 3600_000));
    const ex = await create({ stateDir: dir, runJob: controlledRun().runJob });
    expect(await ex.status(ID1)).toBeNull();
    expect((await ex.status(ID2)).status).toBe("succeeded");
  });

  it("runs the real job runner against the fake CLI and redacts the key", async () => {
    const { runJob } = await load("../container/job-runner.mjs");
    const ex = await create({
      stateDir: await stateDir(),
      runJob: (s: Any, o: Any) => runJob(s, { ...o, bin: FAKE_BIN }),
    });
    await ex.start(ID1, spec(ID1), "u");
    await until(async () => (await ex.status(ID1))?.status === "succeeded");
    const view = await ex.status(ID1);
    expect(view.result.exitCode).toBe(0);
    expect(view.result.outputs.map((o: Any) => o.name).sort()).toEqual([
      "1-result.txt",
      "result.txt",
    ]);
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(view.result.stderrTail).toContain("[redacted]");
  });

  it("reads the concurrency cap from MULTIX_LOCAL_MAX_CONCURRENT_JOBS", async () => {
    const { maxConcurrentFromEnv } = await mod();
    expect(maxConcurrentFromEnv({})).toBe(1);
    expect(maxConcurrentFromEnv({ MULTIX_LOCAL_MAX_CONCURRENT_JOBS: "3" })).toBe(3);
    for (const bad of ["0", "-1", "1.5", "abc", "65"]) {
      expect(() => maxConcurrentFromEnv({ MULTIX_LOCAL_MAX_CONCURRENT_JOBS: bad })).toThrow();
    }
  });
});
