import { describe, expect, it } from "vitest";
import { DEFAULT_JOB_CAPS, type JobQuota } from "../src/jobs/account-job-quota.js";
import type { JobSpec, JobView } from "../src/jobs/job-protocol.js";
import { SERVER_AT_CAPACITY_ERROR } from "../src/jobs/job-protocol.js";
import type { JobToolsContext } from "../src/jobs/job-runner.js";
import { type JobBackend, JobStore } from "../src/jobs/job-store.js";
import type { AccountUsageStub } from "../src/usage/account-usage.js";
import { type UsageOutboxRecord, relayUsage, settleInputFor } from "../src/usage/usage-outbox.js";
import type { SettleInput } from "../src/usage/usage-types.js";
import { fakeKv } from "./fake-kv.js";
import { callTool, fullEnv } from "./helpers.js";
import { memoryUsageNamespace } from "./usage-sql.js";

const env = fullEnv();
const T0 = Date.UTC(2026, 9, 26, 12);

const finished = (spec: JobSpec): JobView => ({
  status: "succeeded",
  createdAt: T0,
  runningAt: T0 + 1_000,
  finishedAt: T0 + 9_000,
  result: {
    status: "succeeded",
    exitCode: 0,
    stdout: `ran ${spec.argv?.join(" ")}`,
    stderrTail: "",
    outputs: [{ name: "cat.png", url: "https://media.example.com/cat.png", bytes: 42 }],
    timings: { inputsMs: 0, cliMs: 7_000, uploadMs: 500 },
    run: {
      command: "gemini generate",
      provider: "gemini",
      model: "gemini-3-pro-image",
      ok: true,
      exitCode: 0,
      durationMs: 6_000,
      usage: { cost_usd: 0.04 },
      http: { requests: 1, errors: 0, ms: 6_000 },
    },
  },
});

class Backend implements JobBackend {
  readonly specs = new Map<string, JobSpec>();
  constructor(private readonly start_: (spec: JobSpec) => JobView = finished) {}
  async start(jobId: string, spec: JobSpec): Promise<JobView> {
    this.specs.set(jobId, spec);
    return this.start_(spec);
  }
  async status(jobId: string): Promise<JobView | null> {
    const spec = this.specs.get(jobId);
    return spec ? this.start_(spec) : null;
  }
  async cancel(): Promise<JobView | null> {
    return null;
  }
}

const freeQuota: JobQuota = {
  acquire: async () => "ok",
  release: async () => undefined,
};

function setup(backend: JobBackend = new Backend(), usage?: AccountUsageStub | null) {
  const ns = memoryUsageNamespace(() => T0);
  const jobs: JobToolsContext = {
    userId: "gh-1",
    keys: { GEMINI_API_KEY: "AIza-gemini-secret-value-1234" },
    store: new JobStore(fakeKv()),
    backend,
    quota: freeQuota,
    caps: DEFAULT_JOB_CAPS,
    r2Settings: async () => null,
    sleep: async () => undefined,
    now: () => T0,
    usage: usage === null ? undefined : (usage ?? ns.namespace.getByName("gh-1")),
    source: "mcp",
    clientId: "mcp:client-1",
  };
  return { jobs, ledger: ns.service("gh-1") };
}

const run = (jobs: JobToolsContext, extra: Record<string, unknown> = {}) =>
  callTool(
    env,
    "multix_run",
    {
      command: "gemini generate",
      options: { prompt: "a cat", model: "gemini-3-pro-image" },
      wait_seconds: 5,
      ...extra,
    },
    { jobs },
  );

describe("job usage capture", () => {
  it("records a pending event before the job starts, tagged with caller and project", async () => {
    const { jobs, ledger } = setup();
    const result = await run(jobs, { project: "site-redesign" });
    expect(result.isError).toBeUndefined();
    const id = result.structuredContent.job_id;
    const detail = ledger.event(id);
    expect(detail?.event).toMatchObject({
      source: "mcp",
      clientId: "mcp:client-1",
      project: "site-redesign",
      provider: "gemini",
      command: "gemini generate",
      modelRequested: "gemini-3-pro-image",
      status: "submitted",
    });
    expect(result.structuredContent.usage).toMatchObject({
      provider: "gemini",
      model: "gemini-3-pro-image",
      cost_usd: 0.04,
    });
  });

  it("rejects an invalid project before anything starts", async () => {
    const backend = new Backend();
    const { jobs } = setup(backend, null);
    const result = await run(jobs, { project: "bad project!" });
    expect(result.isError).toBe(true);
    expect(backend.specs.size).toBe(0);
  });

  it("refuses a job a blocking budget cannot cover, and starts nothing", async () => {
    const backend = new Backend();
    const { jobs, ledger } = setup(backend);
    ledger.createBudget(
      {
        name: "Hard cap",
        scope: "account",
        period: "month",
        limitUsd: 1,
        mode: "block",
        unknownPrice: "block",
      },
      "t",
    );
    const result = await run(jobs);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/budget/i);
    expect(backend.specs.size).toBe(0);
    const events = ledger.events({ from: T0 - 1, to: T0 + 1 }, null);
    expect(events.ok && events.value.items[0]?.status).toBe("rejected");
  });

  it("fails closed when the ledger cannot be reached", async () => {
    const backend = new Backend();
    const broken = new Proxy({} as AccountUsageStub, {
      get: () => async () => {
        throw new Error("DO unavailable");
      },
    });
    const { jobs } = setup(backend, broken);
    const result = await run(jobs);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/usage ledger is unavailable/);
    expect(backend.specs.size).toBe(0);
  });

  it("releases the event when the server is at capacity", async () => {
    const backend = new Backend(() => ({
      status: "failed",
      createdAt: T0,
      finishedAt: T0,
      error: SERVER_AT_CAPACITY_ERROR,
    }));
    const { jobs, ledger } = setup(backend);
    const result = await run(jobs);
    expect(result.isError).toBe(true);
    const events = ledger.events({ from: T0 - 1, to: T0 + 1 }, null);
    const event = events.ok ? events.value.items[0] : undefined;
    expect(event).toMatchObject({ chargeState: "no_charge" });
    // A later settle for the same job is ignored.
    const replay = ledger.settle(
      settleInputFor(event?.id ?? "", finished({ argv: [] } as unknown as JobSpec)) as SettleInput,
    );
    expect(replay).toMatchObject({ chargeState: "no_charge", status: event?.status });
  });

  it("runs without a ledger binding", async () => {
    const { jobs } = setup(new Backend(), null);
    const result = await run(jobs, { project: "p1" });
    expect(result.isError).toBeUndefined();
  });

  it("multix_usage returns the digest with known cost and budgets", async () => {
    const { jobs, ledger } = setup();
    const started = await run(jobs);
    const id = started.structuredContent.job_id;
    ledger.settle(settleInputFor(id, finished({ argv: [] } as unknown as JobSpec)) as SettleInput);
    const result = await callTool(
      env,
      "multix_usage",
      { from: "2026-10-01", to: "2026-10-26" },
      { jobs },
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.kpis).toMatchObject({ jobs: 1 });
    expect(result.structuredContent.topProviders[0]).toMatchObject({ key: "gemini" });

    const bad = await callTool(
      env,
      "multix_usage",
      { from: "2026-10-30", to: "2026-10-01" },
      { jobs },
    );
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/from must be before to/);
  });

  it("offers multix_usage only when the ledger is bound", async () => {
    const { jobs } = setup(new Backend(), null);
    await expect(callTool(env, "multix_usage", {}, { jobs })).rejects.toThrow(/not found/);
  });
});

describe("usage outbox", () => {
  it("settleInputFor reduces a finished view to counts and timings", () => {
    expect(settleInputFor("j1", { status: "running", createdAt: T0 })).toBeUndefined();
    const input = settleInputFor("j1", finished({ argv: [] } as unknown as JobSpec));
    expect(input).toMatchObject({
      jobId: "j1",
      status: "succeeded",
      runningAt: T0 + 1_000,
      exitCode: 0,
      outputs: [{ name: "cat.png", bytes: 42, stored: true }],
      timings: { cliMs: 7_000 },
    });
    expect(JSON.stringify(input)).not.toContain("https://");
  });

  it("relays once and removes the record, retries on failure, gives up at the limit", async () => {
    const record: UsageOutboxRecord = {
      userId: "gh-1",
      input: settleInputFor("j1", finished({ argv: [] } as unknown as JobSpec)) as SettleInput,
    };
    let stored: UsageOutboxRecord | undefined = record;
    const scheduled: number[] = [];
    let fail = true;
    const port = {
      load: async () => stored,
      remove: async () => {
        stored = undefined;
      },
      settle: async () => {
        if (fail) throw new Error("DO busy");
      },
      scheduleRelay: async (attempt: number) => {
        scheduled.push(attempt);
      },
    };
    await relayUsage(port, 1);
    expect(stored).toBeDefined();
    expect(scheduled).toEqual([2]);

    fail = false;
    await relayUsage(port, 2);
    expect(stored).toBeUndefined();

    stored = record;
    fail = true;
    scheduled.length = 0;
    await relayUsage(port, 1_000);
    expect(scheduled).toEqual([]);
  });
});
