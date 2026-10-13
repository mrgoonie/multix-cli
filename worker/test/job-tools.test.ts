import { describe, expect, it } from "vitest";
import type { R2Settings } from "../src/accounts/r2-settings.js";
import type { JobSpec, JobView } from "../src/jobs/job-protocol.js";
import { type JobToolsContext, NO_STORAGE_NOTE, outputKeyPrefix } from "../src/jobs/job-runner.js";
import { type JobBackend, JobStore } from "../src/jobs/job-store.js";
import { fakeKv } from "./fake-kv.js";
import { callTool, fullEnv, rpc } from "./helpers.js";

const GEMINI_KEY = "AIza-gemini-secret-value-1234";
const R2: R2Settings = {
  accountId: "0123456789abcdef0123456789abcdef",
  accessKeyId: "r2-access-key-id-123456",
  secretAccessKey: "r2-secret-access-key-value-123456",
  bucket: "media",
};

/** Backend stub: each job reports `running` for `runningPolls` status reads, then `final`. */
class FakeBackend implements JobBackend {
  readonly specs = new Map<string, JobSpec>();
  readonly canceled: string[] = [];
  private readonly polls = new Map<string, number>();

  constructor(
    private readonly final: (spec: JobSpec) => JobView,
    private readonly runningPolls = 1,
  ) {}

  async start(jobId: string, spec: JobSpec): Promise<JobView> {
    this.specs.set(jobId, spec);
    this.polls.set(jobId, 0);
    return { status: "running", createdAt: 1 };
  }

  async status(jobId: string): Promise<JobView | null> {
    const spec = this.specs.get(jobId);
    if (!spec) return null;
    const n = (this.polls.get(jobId) ?? 0) + 1;
    this.polls.set(jobId, n);
    if (this.canceled.includes(jobId)) return { status: "canceled", createdAt: 1, finishedAt: 2 };
    return n > this.runningPolls ? this.final(spec) : { status: "running", createdAt: 1 };
  }

  async cancel(jobId: string): Promise<JobView | null> {
    if (!this.specs.has(jobId)) return null;
    this.canceled.push(jobId);
    return { status: "canceled", createdAt: 1, finishedAt: 2, error: "Canceled by the caller" };
  }
}

const succeeded = (spec: JobSpec): JobView => ({
  status: "succeeded",
  createdAt: 1,
  finishedAt: 2,
  result: {
    status: "succeeded",
    exitCode: 0,
    stdout: `saved out/cat.png with key ${spec.env.GEMINI_API_KEY ?? "none"}`,
    stderrTail: `debug ${spec.upload?.r2.secretAccessKey ?? ""}`,
    outputs: [{ name: "cat.png", url: "https://media.example.com/cat.png", bytes: 42 }],
  },
});

function jobsContext(
  backend: JobBackend,
  overrides: Partial<JobToolsContext> = {},
): JobToolsContext & { clock: { t: number } } {
  const clock = { t: 0 };
  return {
    userId: "gh-1",
    keys: { GEMINI_API_KEY: GEMINI_KEY },
    store: new JobStore(fakeKv()),
    backend,
    r2Settings: async () => null,
    sleep: async (ms) => {
      clock.t += ms;
    },
    now: () => clock.t,
    clock,
    ...overrides,
  };
}

const env = fullEnv({ GEMINI_API_KEY: GEMINI_KEY });

describe("CLI runner tools", () => {
  it("are listed only when the job backend is available", async () => {
    const withJobs = await rpc(
      env,
      "tools/list",
      {},
      { jobs: jobsContext(new FakeBackend(succeeded)) },
    );
    const names = withJobs.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "multix_catalog",
        "multix_run",
        "multix_job_status",
        "multix_job_cancel",
      ]),
    );
    expect(names).toHaveLength(9);
    const without = await rpc(env, "tools/list");
    expect(without.result.tools).toHaveLength(5);
  });

  it("multix_catalog lists groups with key readiness and never key values", async () => {
    const jobs = jobsContext(new FakeBackend(succeeded));
    const result = await callTool(env, "multix_catalog", {}, { jobs });
    const groups = result.structuredContent.groups as { group: string; has_keys: boolean }[];
    const byName = Object.fromEntries(groups.map((g) => [g.group, g.has_keys]));
    expect(byName).toMatchObject({ gemini: true, openai: false, media: true });
    expect(byName.check).toBeUndefined();
    expect(byName.update).toBeUndefined();
    expect(result.content[0].text).not.toContain(GEMINI_KEY);

    const detail = await callTool(env, "multix_catalog", { group: "openai" }, { jobs });
    const generate = detail.structuredContent.commands.find(
      (c: { command: string }) => c.command === "openai generate",
    );
    const driver = generate.options.find((o: { name: string }) => o.name === "driver");
    expect(driver.forced).toBe("api");
    const unknown = await callTool(env, "multix_catalog", { group: "nope" }, { jobs });
    expect(unknown.isError).toBe(true);
  });

  it("runs a job, waits for it, and scrubs keys from its output (no R2: note, no upload)", async () => {
    const backend = new FakeBackend(succeeded, 2);
    const jobs = jobsContext(backend);
    const result = await callTool(
      env,
      "multix_run",
      { command: "gemini generate", options: { prompt: "a cat" }, wait_seconds: 10 },
      { jobs },
    );
    expect(result.isError).toBeUndefined();
    const payload = result.structuredContent;
    expect(payload).toMatchObject({ status: "succeeded", exit_code: 0, note: NO_STORAGE_NOTE });
    expect(payload.outputs).toEqual([
      { name: "cat.png", url: "https://media.example.com/cat.png", bytes: 42 },
    ]);
    expect(payload.stdout).toBe("saved out/cat.png with key [redacted]");
    expect(result.content[0].text).not.toContain(GEMINI_KEY);

    const spec = backend.specs.get(payload.job_id);
    expect(spec?.argv).toEqual(["gemini", "generate", "--prompt=a cat"]);
    expect(spec?.env).toEqual({ GEMINI_API_KEY: GEMINI_KEY });
    expect(spec?.upload).toBeUndefined();
    expect(jobs.clock.t).toBe(6_000); // two running reads, then the result, 2 s apart
  });

  it("uploads to the account's R2 prefix and scrubs R2 credentials", async () => {
    const backend = new FakeBackend(succeeded, 0);
    const jobs = jobsContext(backend, { r2Settings: async () => R2 });
    const result = await callTool(
      env,
      "multix_run",
      { command: "gemini generate", options: { prompt: "a cat" } },
      { jobs },
    );
    const payload = result.structuredContent;
    const spec = backend.specs.get(payload.job_id);
    expect(spec?.upload?.keyPrefix).toBe(await outputKeyPrefix("gh-1", payload.job_id));
    expect(spec?.upload?.keyPrefix).toMatch(/^multix\/[0-9a-f]{16}\/[0-9a-f-]{36}$/);
    expect(payload.note).toBeUndefined();
    expect(payload.stderr_tail).toBe("debug [redacted]");
  });

  it("returns a running job after wait_seconds and lets only its owner read or cancel it", async () => {
    const backend = new FakeBackend(succeeded, 100);
    const store = new JobStore(fakeKv());
    const owner = jobsContext(backend, { store });
    const started = await callTool(
      env,
      "multix_run",
      { command: "gemini generate", options: { prompt: "slow" }, wait_seconds: 0 },
      { jobs: owner },
    );
    const jobId = started.structuredContent.job_id as string;
    expect(started.structuredContent).toMatchObject({
      status: "running",
      next: { tool: "multix_job_status", arguments: { job_id: jobId } },
    });

    const intruder = jobsContext(backend, { store, userId: "gh-2" });
    for (const tool of ["multix_job_status", "multix_job_cancel"]) {
      const denied = await callTool(env, tool, { job_id: jobId }, { jobs: intruder });
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toBe("Job not found");
    }
    expect(backend.canceled).toEqual([]);

    const status = await callTool(env, "multix_job_status", { job_id: jobId }, { jobs: owner });
    expect(status.structuredContent.status).toBe("running");
    const canceled = await callTool(env, "multix_job_cancel", { job_id: jobId }, { jobs: owner });
    expect(canceled.structuredContent).toMatchObject({ status: "canceled" });
    expect(backend.canceled).toEqual([jobId]);
    const missing = await callTool(
      env,
      "multix_job_status",
      { job_id: "not-a-job" },
      { jobs: owner },
    );
    expect(missing.content[0].text).toBe("Job not found");
  });

  it("reports validation errors with CLI flag names and starts nothing", async () => {
    const backend = new FakeBackend(succeeded);
    const jobs = jobsContext(backend);
    const result = await callTool(
      env,
      "multix_run",
      { command: "gemini generate", options: { prompt: "p", "num-images": 9 } },
      { jobs },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("--num-images must be at most 4 on this server");
    expect(backend.specs.size).toBe(0);
  });
});
