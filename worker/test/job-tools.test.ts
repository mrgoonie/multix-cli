import { describe, expect, it } from "vitest";
import type { R2Settings } from "../src/accounts/r2-settings.js";
import {
  type AcquireResult,
  DEFAULT_JOB_CAPS,
  type JobCaps,
  type JobQuota,
  SERVER_SLOTS_NAME,
  accountBusyError,
  takeSlot,
} from "../src/jobs/account-job-quota.js";
import { type JobSpec, type JobView, SERVER_AT_CAPACITY_ERROR } from "../src/jobs/job-protocol.js";
import { type JobToolsContext, NO_STORAGE_NOTE, outputKeyPrefix } from "../src/jobs/job-runner.js";
import { type JobBackend, JobStore } from "../src/jobs/job-store.js";
import { fakeKv } from "./fake-kv.js";
import legacySchemas from "./fixtures/legacy-tool-input-schemas.json";
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

  async start(jobId: string, spec: JobSpec, _userId: string): Promise<JobView> {
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

/** In-memory JobQuota with the real slot rules, keyed by account plus one server-wide set. */
class FakeQuota implements JobQuota {
  readonly slots = new Map<string, Record<string, number>>();
  readonly released: string[] = [];

  constructor(readonly caps: JobCaps = DEFAULT_JOB_CAPS) {}

  private take(name: string, jobId: string, limit: number): boolean {
    const { ok, slots } = takeSlot(this.slots.get(name) ?? {}, jobId, 0, limit);
    this.slots.set(name, slots);
    return ok;
  }

  async acquire(userId: string, jobId: string): Promise<AcquireResult> {
    if (!this.take(userId, jobId, this.caps.perAccount)) return "account-busy";
    if (this.take(SERVER_SLOTS_NAME, jobId, this.caps.total)) return "ok";
    delete this.slots.get(userId)?.[jobId];
    return "server-busy";
  }

  async release(userId: string, jobId: string): Promise<void> {
    this.released.push(jobId);
    delete this.slots.get(userId)?.[jobId];
    delete this.slots.get(SERVER_SLOTS_NAME)?.[jobId];
  }
}

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
    quota: new FakeQuota(),
    caps: DEFAULT_JOB_CAPS,
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

type JsonSchema = { properties: Record<string, unknown>; [key: string]: unknown };
const pick = (obj: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

describe("CLI runner tools", () => {
  it("keeps the tool input schemas 2025 clients already know", async () => {
    const list = await rpc(
      env,
      "tools/list",
      {},
      { jobs: jobsContext(new FakeBackend(succeeded)) },
    );
    const schemas = Object.fromEntries(
      list.result.tools.map((t: { name: string; inputSchema: unknown }) => [t.name, t.inputSchema]),
    );
    // New optional parameters are allowed; anything a 2025 client sends must
    // still validate the same way.
    expect(Object.keys(schemas).sort()).toEqual(Object.keys(legacySchemas).sort());
    for (const [name, legacy] of Object.entries(legacySchemas) as [string, JsonSchema][]) {
      const current = schemas[name] as JsonSchema;
      const { properties: legacyProps, ...legacyRest } = legacy;
      const { properties: currentProps, ...currentRest } = current;
      expect(currentRest, name).toEqual(legacyRest);
      expect(pick(currentProps, Object.keys(legacyProps)), name).toEqual(legacyProps);
    }
  });

  it("lists the job tools only when the job backend is available", async () => {
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
    expect(names).toHaveLength(4);
    const without = await rpc(env, "tools/list");
    expect(without.result.tools.map((t: { name: string }) => t.name)).toEqual(["multix_catalog"]);
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

  it("multix_catalog filters by task and inspects verified models from the CLI registry", async () => {
    const jobs = jobsContext(new FakeBackend(succeeded));
    const speech = (await callTool(env, "multix_catalog", { task: "speech" }, { jobs }))
      .structuredContent;
    expect(speech.schema).toBe("multix.capabilities/v1");
    const commands = speech.commands.map((c: { command: string }) => c.command);
    expect(commands).toContain("gemini generate-speech");
    expect(commands).not.toContain("fal run");
    expect(commands).not.toContain("openrouter generate");
    const models = speech.models as { model: string; command: string; has_keys: boolean }[];
    expect(models.map((m) => m.model)).toContain("elevenlabs/tts/eleven-v4");
    expect(models.every((m) => m.command.startsWith("fal ") && m.has_keys === false)).toBe(true);
    expect(models.find((m) => m.model === "elevenlabs/tts/eleven-v4")?.command).toBe("fal tts");
    const tts = speech.commands.find(
      (c: { command: string }) => c.command === "gemini generate-speech",
    );
    expect(tts).toMatchObject({ has_keys: true, tasks: ["speech"], outputs: ["audio"] });

    const inGroup = (
      await callTool(env, "multix_catalog", { task: "speech", group: "gemini" }, { jobs })
    ).structuredContent;
    expect(inGroup.commands.map((c: { command: string }) => c.command)).toEqual([
      "gemini generate-speech",
    ]);
    expect(inGroup.models).toEqual([]);

    const model = (
      await callTool(env, "multix_catalog", { model: "google/gemini-3.8-flash-tts" }, { jobs })
    ).structuredContent;
    expect(model.verified).toMatchObject({ provider: "fal", command: "fal tts" });
    expect(model.verified.voices).toContain("Kore");
    expect(model.usage).toContain('command "fal tts", args ["<text>"]');

    const runner = (
      await callTool(env, "multix_catalog", { model: "fal-ai/minimax/speech-2.8-hd" }, { jobs })
    ).structuredContent;
    expect(runner.usage).toContain('command "fal run", args ["fal-ai/minimax/speech-2.8-hd"]');

    const unknownModel = (
      await callTool(env, "multix_catalog", { model: "someone/new-model" }, { jobs })
    ).structuredContent;
    expect(unknownModel.verified).toBeNull();

    const badTask = await callTool(env, "multix_catalog", { task: "telepathy" }, { jobs });
    expect(badTask.isError).toBe(true);
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

  it("uploads under the account's chosen directory path", async () => {
    const backend = new FakeBackend(succeeded, 0);
    const jobs = jobsContext(backend, { r2Settings: async () => ({ ...R2, prefix: "team/out" }) });
    const result = await callTool(
      env,
      "multix_run",
      { command: "gemini generate", options: { prompt: "a cat" } },
      { jobs },
    );
    const spec = backend.specs.get(result.structuredContent.job_id);
    expect(spec?.upload?.keyPrefix).toMatch(/^team\/out\/[0-9a-f]{16}\/[0-9a-f-]{36}$/);
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

  it("caps running jobs per account with a distinct busy error", async () => {
    const backend = new FakeBackend(succeeded, 100);
    const quota = new FakeQuota();
    const run = (jobs: JobToolsContext) =>
      callTool(
        env,
        "multix_run",
        { command: "gemini generate", options: { prompt: "p" }, wait_seconds: 0 },
        { jobs },
      );
    const mine = jobsContext(backend, { quota });
    expect((await run(mine)).structuredContent.status).toBe("running");
    expect((await run(mine)).structuredContent.status).toBe("running");
    const third = await run(mine);
    expect(third.isError).toBe(true);
    expect(third.content[0].text).toBe(accountBusyError(2));
    expect(third.content[0].text).toMatch(/^busy: you already have 2 running jobs/);
    expect(third.structuredContent?.error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(backend.specs.size).toBe(2);
    // Another account is not affected.
    const other = jobsContext(backend, { quota, userId: "gh-2" });
    expect((await run(other)).structuredContent.status).toBe("running");
  });

  it("applies configured caps: per account and server-wide", async () => {
    const backend = new FakeBackend(succeeded, 100);
    const caps = { perAccount: 1, total: 2 };
    const quota = new FakeQuota(caps);
    const run = (userId: string) =>
      callTool(
        env,
        "multix_run",
        { command: "gemini generate", options: { prompt: "p" }, wait_seconds: 0 },
        { jobs: jobsContext(backend, { quota, caps, userId }) },
      );
    expect((await run("gh-1")).structuredContent.status).toBe("running");
    const second = await run("gh-1");
    expect(second.content[0].text).toBe(
      "busy: you already have 1 running job; wait for one to finish or cancel it",
    );
    expect((await run("gh-2")).structuredContent.status).toBe("running");
    const full = await run("gh-3");
    expect(full.isError).toBe(true);
    expect(full.content[0].text).toBe(SERVER_AT_CAPACITY_ERROR);
    // The refused job keeps no account slot.
    expect(Object.keys(quota.slots.get("gh-3") ?? {})).toHaveLength(0);
    expect(backend.specs.size).toBe(2);
  });

  it("reports a full server separately and gives the slot back when the start fails", async () => {
    const quota = new FakeQuota();
    const full = new FakeBackend(succeeded);
    full.start = async () => ({
      status: "failed",
      createdAt: 1,
      finishedAt: 1,
      error: SERVER_AT_CAPACITY_ERROR,
    });
    const atCapacity = await callTool(
      env,
      "multix_run",
      { command: "gemini generate", options: { prompt: "p" } },
      { jobs: jobsContext(full, { quota }) },
    );
    expect(atCapacity.isError).toBe(true);
    expect(atCapacity.content[0].text).toBe(SERVER_AT_CAPACITY_ERROR);

    const broken = new FakeBackend(succeeded);
    broken.start = async () => {
      throw new Error("rpc lost");
    };
    const failed = await callTool(
      env,
      "multix_run",
      { command: "gemini generate", options: { prompt: "p" } },
      { jobs: jobsContext(broken, { quota }) },
    );
    expect(failed.isError).toBe(true);
    expect(quota.released).toHaveLength(1);
    expect(Object.keys(quota.slots.get("gh-1") ?? {})).toHaveLength(1); // the capacity job's DO releases its own
  });

  it("counts the container start against wait_seconds", async () => {
    const backend = new FakeBackend(succeeded, 100);
    const jobs = jobsContext(backend);
    const slowStart = backend.start.bind(backend);
    backend.start = async (jobId, spec, userId) => {
      jobs.clock.t += 30_000; // a cold start
      return slowStart(jobId, spec, userId);
    };
    const result = await callTool(
      env,
      "multix_run",
      { command: "gemini generate", options: { prompt: "p" }, wait_seconds: 40 },
      { jobs },
    );
    expect(result.structuredContent.status).toBe("running");
    expect(jobs.clock.t).toBe(40_000);
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
    expect(result.structuredContent?.error).toMatchObject({
      code: "INVALID_INPUT",
      retryable: false,
    });
    expect(backend.specs.size).toBe(0);
  });
});
