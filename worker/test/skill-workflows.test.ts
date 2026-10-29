import { describe, expect, it } from "vitest";
import { limitsFrom } from "../src/config.js";
import {
  type AcquireResult,
  DEFAULT_JOB_CAPS,
  type JobQuota,
} from "../src/jobs/account-job-quota.js";
import type { JobSpec, JobView } from "../src/jobs/job-protocol.js";
import type { JobToolsContext } from "../src/jobs/job-runner.js";
import { type JobBackend, JobStore } from "../src/jobs/job-store.js";
import { prepareRun } from "../src/jobs/run-argv-builder.js";
import { WorkflowManager } from "../src/skills/workflow-manager.js";
import { STEP_LEASE_MS } from "../src/skills/workflow-manager.js";
import {
  WORKFLOW_FILE,
  WorkflowManifestError,
  parseWorkflowManifest,
  renderStep,
  validateRunInputs,
} from "../src/skills/workflow-manifest.js";
import {
  MAX_ACTIVE_RUNS,
  MAX_STORED_RUNS,
  type WorkflowRun,
} from "../src/skills/workflow-store.js";
import { fakeKv } from "./fake-kv.js";
import { callTool, fullEnv, rpc } from "./helpers.js";
import { OTHER, OWNER, fakeRegistries, skillFiles } from "./skills-helpers.js";

const GEMINI_KEY = "AIza-gemini-secret-value-1234";
const limits = limitsFrom(fullEnv());

/** Two steps: draw an image, then restyle the first output of the first step. */
const TWO_STEPS = {
  version: 1,
  description: "Draw, then restyle",
  inputs: {
    subject: { type: "string", required: true, max_length: 200 },
    count: { type: "integer", min: 1, max: 2, default: 1 },
    style: { type: "string", enum: ["watercolor", "ink"] },
  },
  steps: [
    {
      id: "draw",
      command: "gemini generate",
      options: { prompt: "A photo of {{inputs.subject}}", "num-images": "{{inputs.count}}" },
    },
    {
      id: "restyle",
      command: "gemini image-to-image",
      options: { prompt: "{{inputs.style}}" },
      inputs: { ref: "{{steps.draw.outputs[0]}}" },
    },
  ],
};

/** Backend stub: a job is `running` for `runningPolls` status reads, then succeeds with one output. */
class FakeBackend implements JobBackend {
  readonly specs = new Map<string, JobSpec>();
  readonly started: string[] = [];
  readonly canceled: string[] = [];
  private readonly polls = new Map<string, number>();
  fail = false;
  /** The next start throws before the job exists, like a lost connection. */
  failStart = false;

  constructor(private readonly runningPolls = 0) {}

  async start(jobId: string, spec: JobSpec): Promise<JobView> {
    if (this.failStart) {
      this.failStart = false;
      throw new Error("connection lost");
    }
    this.specs.set(jobId, spec);
    this.started.push(jobId);
    return { status: "running", createdAt: 1 };
  }

  async status(jobId: string): Promise<JobView | null> {
    if (!this.specs.has(jobId)) return null;
    if (this.canceled.includes(jobId)) return { status: "canceled", createdAt: 1, finishedAt: 2 };
    const n = (this.polls.get(jobId) ?? 0) + 1;
    this.polls.set(jobId, n);
    if (n <= this.runningPolls) return { status: "running", createdAt: 1 };
    if (this.fail) {
      return { status: "failed", createdAt: 1, finishedAt: 2, error: `boom ${GEMINI_KEY}` };
    }
    const n2 = this.started.indexOf(jobId);
    return {
      status: "succeeded",
      createdAt: 1,
      finishedAt: 2,
      result: {
        status: "succeeded",
        exitCode: 0,
        stdout: "",
        stderrTail: "",
        outputs: [{ name: `${n2}.png`, url: `https://media.example.com/${n2}.png`, bytes: 7 }],
      },
    };
  }

  async cancel(jobId: string): Promise<JobView | null> {
    if (!this.specs.has(jobId)) return null;
    this.canceled.push(jobId);
    return { status: "canceled", createdAt: 1, finishedAt: 2 };
  }
}

class FakeQuota implements JobQuota {
  busy = false;
  async acquire(): Promise<AcquireResult> {
    return this.busy ? "account-busy" : "ok";
  }
  async release(): Promise<void> {}
}

function setup(userId = OWNER, runningPolls = 0) {
  const registries = fakeRegistries();
  const backend = new FakeBackend(runningPolls);
  const quota = new FakeQuota();
  const jobs: JobToolsContext = {
    userId,
    keys: { GEMINI_API_KEY: GEMINI_KEY },
    store: new JobStore(fakeKv()),
    backend,
    quota,
    caps: DEFAULT_JOB_CAPS,
    r2Settings: async () => null,
    sleep: async () => undefined,
    now: () => 0,
  };
  const manager = (as = userId) =>
    new WorkflowManager({
      userId: as,
      registries,
      jobs: as === userId ? jobs : { ...jobs, userId: as },
      limits,
    });
  return { registries, backend, quota, jobs, manager };
}

async function publishWorkflow(
  registries: ReturnType<typeof fakeRegistries>,
  manifest: unknown = TWO_STEPS,
  owner = OWNER,
  visibility: "private" | "team" = "private",
) {
  return registries.getByName(owner).publish({
    ownerId: owner,
    visibility,
    files: skillFiles("studio", "Image studio", { [WORKFLOW_FILE]: JSON.stringify(manifest) }),
  });
}

async function authorize(manager: WorkflowManager, uri: string, extra: object = {}) {
  const described = await manager.describe(uri);
  return manager.authorize(uri, {
    revision: described.revision,
    digest: described.digest,
    ...extra,
  });
}

/**
 * The registries with `onSave` run around every saveWorkflowRun of `owner`,
 * to break or interleave saves.
 */
function intercepted(
  registries: ReturnType<typeof fakeRegistries>,
  onSave: (
    run: WorkflowRun,
    save: () => Promise<WorkflowRun | null>,
  ) => Promise<WorkflowRun | null>,
) {
  return {
    getByName(accountId: string) {
      const real = registries.getByName(accountId);
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop !== "saveWorkflowRun") return Reflect.get(target, prop, receiver);
          return (id: string, run: WorkflowRun) =>
            onSave(run, () => target.saveWorkflowRun(id, run));
        },
      });
    },
  };
}

const URI = "skill://private/studio/SKILL.md";

describe("workflow manifest", () => {
  it("accepts a valid manifest and keeps its steps", () => {
    const manifest = parseWorkflowManifest(JSON.stringify(TWO_STEPS));
    expect(manifest.steps.map((s) => s.command)).toEqual([
      "gemini generate",
      "gemini image-to-image",
    ]);
    expect(manifest.inputs.count).toMatchObject({ type: "integer", default: 1 });
  });

  it.each([
    [{ ...TWO_STEPS, version: 2 }, /version must be 1/],
    [{ ...TWO_STEPS, run: "rm -rf /" }, /unknown field "run"/],
    [{ ...TWO_STEPS, steps: [] }, /1 to 10 steps/],
    [{ ...TWO_STEPS, steps: Array(11).fill(TWO_STEPS.steps[0]) }, /1 to 10 steps/],
    [{ ...TWO_STEPS, steps: [{ id: "x", command: "check" }] }, /not a command this server runs/],
    [{ ...TWO_STEPS, steps: [{ id: "x", command: "bash -c" }] }, /not a command this server runs/],
    [
      { ...TWO_STEPS, steps: [TWO_STEPS.steps[1], TWO_STEPS.steps[0]] },
      /"draw" is not an earlier step/,
    ],
    [
      { ...TWO_STEPS, steps: [{ id: "a", command: "gemini generate", args: ["{{inputs.nope}}"] }] },
      /input "nope" is not declared/,
    ],
    [
      {
        ...TWO_STEPS,
        steps: [{ id: "a", command: "gemini generate", options: { prompt: "{{env.HOME}}" } }],
      },
      /is not \{\{inputs/,
    ],
    [
      { ...TWO_STEPS, steps: [{ id: "a", command: "gemini generate", options: { "--x y": "1" } }] },
      /not a valid option name/,
    ],
    [{ ...TWO_STEPS, inputs: { n: { type: "integer", min: 5, max: 1 } } }, /min is above max/],
    [{ ...TWO_STEPS, inputs: { n: { type: "string", default: 3 } } }, /must be a string/],
    [{ ...TWO_STEPS, steps: [TWO_STEPS.steps[0], { ...TWO_STEPS.steps[0] }] }, /used twice/],
  ])("refuses an invalid manifest %#", (manifest, message) => {
    expect(() => parseWorkflowManifest(JSON.stringify(manifest))).toThrow(message);
  });

  it("refuses text that is not JSON or too large", () => {
    expect(() => parseWorkflowManifest("{")).toThrow(WorkflowManifestError);
    expect(() => parseWorkflowManifest(" ".repeat(70 * 1024))).toThrow(/at most 65536 bytes/);
  });

  it("checks run inputs: required, types, bounds, enums and unknown names", () => {
    const manifest = parseWorkflowManifest(JSON.stringify(TWO_STEPS));
    expect(validateRunInputs(manifest, { subject: "a fox" })).toEqual({
      subject: "a fox",
      count: 1,
    });
    expect(() => validateRunInputs(manifest, {})).toThrow(/"subject" is required/);
    expect(() => validateRunInputs(manifest, { subject: "x", count: 3 })).toThrow(/at most 2/);
    expect(() => validateRunInputs(manifest, { subject: "x", count: 1.5 })).toThrow(/integer/);
    expect(() => validateRunInputs(manifest, { subject: "x", style: "oil" })).toThrow(/one of/);
    expect(() => validateRunInputs(manifest, { subject: "x", extra: 1 })).toThrow(/unknown input/);
    expect(() => validateRunInputs(manifest, { subject: "x".repeat(201) })).toThrow(/200/);
    const urls = parseWorkflowManifest(
      JSON.stringify({
        version: 1,
        inputs: { image: { type: "url", required: true } },
        steps: [{ id: "a", command: "gemini image-to-image", inputs: { ref: "{{inputs.image}}" } }],
      }),
    );
    expect(() => validateRunInputs(urls, { image: "http://169.254.169.254/" })).toThrow(/https/);
  });

  it("renders typed values, drops absent optional inputs and keeps each value one argument", () => {
    const manifest = parseWorkflowManifest(JSON.stringify(TWO_STEPS));
    const inputs = validateRunInputs(manifest, { subject: "--output=/etc/passwd -- x" });
    const first = renderStep(manifest.steps[0] as never, inputs, {});
    expect(first.options).toEqual({
      prompt: "A photo of --output=/etc/passwd -- x",
      "num-images": 1,
    });
    const argv = prepareRun(first, limits).argv;
    expect(argv).toContain("--prompt=A photo of --output=/etc/passwd -- x");
    expect(argv.filter((a) => a.startsWith("--output"))).toEqual([]);

    const second = renderStep(manifest.steps[1] as never, inputs, {
      draw: ["https://media.example.com/a.png"],
    });
    // style is optional and absent, so --prompt is left out rather than sent empty.
    expect(second.options).toEqual({});
    expect(second.inputs).toEqual({ ref: "https://media.example.com/a.png" });
    expect(() => renderStep(manifest.steps[1] as never, inputs, { draw: [null] })).toThrow(
      /no URL/,
    );
    expect(() => renderStep(manifest.steps[1] as never, inputs, { draw: [] })).toThrow(
      /produced 0 output/,
    );
  });
});

describe("workflow publishing", () => {
  it("refuses a positional that an absent optional input would leave out", () => {
    const manifest = {
      version: 1,
      inputs: { a: { type: "string" }, b: { type: "string", required: true } },
      steps: [{ id: "x", command: "gemini generate", args: ["{{inputs.a}}", "{{inputs.b}}"] }],
    };
    expect(() => parseWorkflowManifest(JSON.stringify(manifest))).toThrow(
      /args\[0\]: positional .* needs a required input or one with a default/,
    );
    manifest.inputs.a = { type: "string", default: "A" } as never;
    expect(parseWorkflowManifest(JSON.stringify(manifest)).steps[0]?.args).toHaveLength(2);
  });

  it("does not take inherited object keys for declared inputs", () => {
    const manifest = {
      ...TWO_STEPS,
      steps: [
        { id: "x", command: "gemini generate", options: { prompt: "{{inputs.constructor}}" } },
      ],
    };
    expect(() => parseWorkflowManifest(JSON.stringify(manifest))).toThrow(
      /input "constructor" is not declared/,
    );
    const parsed = parseWorkflowManifest(JSON.stringify(TWO_STEPS));
    expect(() => validateRunInputs(parsed, { subject: "x", hasOwnProperty: "y" })).toThrow(
      /unknown input "hasOwnProperty"/,
    );
  });

  it("refuses to publish a skill with an invalid manifest, in full or from a draft", async () => {
    const registries = fakeRegistries();
    const own = registries.getByName(OWNER);
    await expect(publishWorkflow(registries, { version: 1, steps: [] })).rejects.toThrow(
      /multix\.workflow\.json: steps must be/,
    );
    await own.saveDraft({
      ownerId: OWNER,
      name: "studio",
      files: skillFiles("studio", "Image studio", { [WORKFLOW_FILE]: "not json" }),
    });
    await expect(own.publishDraft({ ownerId: OWNER, name: "studio" })).rejects.toThrow(
      /multix\.workflow\.json is not valid JSON/,
    );
    expect(await own.skill(OWNER, "studio")).toBeNull();
  });
});

describe("workflow runs", () => {
  it("describes the workflow and refuses to run it before an authorization", async () => {
    const { registries, backend, manager } = setup();
    await publishWorkflow(registries);
    const described = await manager().describe(URI);
    expect(described).toMatchObject({
      uri: URI,
      revision: 1,
      authorized: false,
      authorization: null,
      authorize: { method: "POST", path: "/api/v1/workflow-authorizations" },
    });
    expect(described.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    await expect(manager().start(URI, { subject: "a fox" })).rejects.toMatchObject({
      reason: "not_authorized",
    });
    expect(backend.started).toEqual([]);
  });

  it("authorizes only the served revision and digest", async () => {
    const { registries, manager } = setup();
    await publishWorkflow(registries);
    const { digest } = await manager().describe(URI);
    await expect(manager().authorize(URI, { revision: 2, digest })).rejects.toMatchObject({
      reason: "conflict",
    });
    await expect(
      manager().authorize(URI, { revision: 1, digest: `sha256:${"0".repeat(64)}` }),
    ).rejects.toMatchObject({ reason: "conflict" });
    await expect(
      manager().authorize(URI, { revision: 1, digest, max_cost_usd: -1 }),
    ).rejects.toMatchObject({ reason: "invalid" });
    const { authorization } = await manager().authorize(URI, { revision: 1, digest });
    expect(authorization).toMatchObject({ revision: 1, digest, cost_policy: "strict" });
    expect((await manager().describe(URI)).authorized).toBe(true);
  });

  it("runs the steps in order and passes outputs forward", async () => {
    const { registries, backend, manager } = setup(OWNER, 1);
    await publishWorkflow(registries);
    await authorize(manager(), URI);
    const started = await manager().start(URI, { subject: "a fox", style: "ink" });
    expect(started).toMatchObject({ status: "running", current_step: "draw" });
    expect(backend.started).toHaveLength(1);
    const firstSpec = backend.specs.get(backend.started[0] as string) as JobSpec;
    expect(firstSpec.argv).toContain("--prompt=A photo of a fox");
    expect(firstSpec.env).toEqual({ GEMINI_API_KEY: GEMINI_KEY });

    // The first read finds the job still running.
    expect(await manager().status(started.run_id)).toMatchObject({
      current_step: "draw",
      steps: [{ status: "running" }, { status: "pending" }],
    });
    // The next read collects the output and starts the second step with it.
    const second = await manager().status(started.run_id);
    expect(second).toMatchObject({
      status: "running",
      current_step: "restyle",
      steps: [
        { status: "succeeded", outputs: [{ url: "https://media.example.com/0.png" }] },
        { status: "running" },
      ],
    });
    const secondSpec = backend.specs.get(backend.started[1] as string) as JobSpec;
    expect(secondSpec.argv).toContain("--prompt=ink");
    expect(secondSpec.inputs).toEqual([
      expect.objectContaining({ url: "https://media.example.com/0.png" }),
    ]);
    await manager().status(started.run_id);
    const done = await manager().status(started.run_id);
    expect(done).toMatchObject({ status: "succeeded", current_step: null });
    expect(done).not.toHaveProperty("next");
    expect(backend.started).toHaveLength(2);
    expect((await manager().list()).runs).toEqual([
      expect.objectContaining({ run_id: started.run_id, status: "succeeded" }),
    ]);
  });

  it("starts a step once when two readers advance the run at the same time", async () => {
    const { registries, backend, manager } = setup();
    await publishWorkflow(registries);
    await authorize(manager(), URI);
    const run = await manager().start(URI, { subject: "a fox", style: "ink" });
    const reads = await Promise.all([1, 2, 3].map(() => manager().status(run.run_id)));
    expect(backend.started).toHaveLength(2);
    expect(reads.some((r) => r.current_step === "restyle")).toBe(true);
  });

  it("adopts a job whose start was not recorded once the lease expires", async () => {
    const { registries, backend, jobs, manager } = setup();
    await publishWorkflow(registries);
    await authorize(manager(), URI);
    // The save that records the started job fails, as when the object resets.
    let broken = true;
    const flaky = intercepted(registries, async (run, save) => {
      if (broken && !run.lease && run.steps[0]?.jobId) {
        broken = false;
        throw new Error("storage reset");
      }
      return save();
    });
    const at = (now: number) =>
      new WorkflowManager({ userId: OWNER, registries: flaky, jobs, limits, now: () => now });
    const t0 = Date.now();
    await expect(at(t0).start(URI, { subject: "a fox", style: "ink" })).rejects.toThrow(
      "storage reset",
    );
    const [run] = (await at(t0).list()).runs;
    const runId = run?.run_id as string;
    expect((await at(t0).status(runId)).steps[0]).toMatchObject({ status: "starting" });
    expect(backend.started).toHaveLength(1);

    const later = at(t0 + STEP_LEASE_MS + 1);
    const adopted = await later.status(runId);
    expect(adopted.steps[0]).toMatchObject({ job_id: backend.started[0] });
    expect(backend.started).toHaveLength(1);
    const next = await later.status(runId);
    expect(next.current_step).toBe("restyle");
    expect(backend.started).toHaveLength(2);
  });

  it("starts the step again when an expired lease's job never started", async () => {
    const { registries, backend, jobs, manager } = setup();
    await publishWorkflow(registries);
    await authorize(manager(), URI);
    backend.failStart = true;
    await expect(manager().start(URI, { subject: "a fox" })).rejects.toThrow("connection lost");
    const runId = (await manager().list()).runs[0]?.run_id as string;
    expect(backend.started).toHaveLength(0);
    const later = new WorkflowManager({
      userId: OWNER,
      registries,
      jobs,
      limits,
      now: () => Date.now() + STEP_LEASE_MS + 1,
    });
    const restarted = await later.status(runId);
    expect(restarted.steps[0]).toMatchObject({ job_id: backend.started[0] });
    expect(backend.started).toHaveLength(1);
  });

  it("starts no job when the run is canceled while its step is being started", async () => {
    const { registries, backend, jobs, manager } = setup();
    await publishWorkflow(registries);
    await authorize(manager(), URI);
    let leases = 0;
    const racing = intercepted(registries, async (run, save) => {
      const saved = await save();
      // Right after the lease is taken, another request cancels the run.
      if (saved && run.lease && !run.steps[0]?.jobId && leases++ === 0) {
        await manager().cancel(run.id);
      }
      return saved;
    });
    const run = await new WorkflowManager({
      userId: OWNER,
      registries: racing,
      jobs,
      limits,
    }).start(URI, { subject: "a fox" });
    expect(run.status).toBe("canceled");
    expect(backend.started).toHaveLength(0);
  });

  it("leaves a step pending, not leased, when jobs are unavailable", async () => {
    const { registries, backend, quota, manager } = setup();
    await publishWorkflow(registries);
    await authorize(manager(), URI);
    quota.busy = true;
    const run = await manager().start(URI, { subject: "a fox" });
    quota.busy = false;
    const noJobs = new WorkflowManager({ userId: OWNER, registries, limits });
    await expect(noJobs.status(run.run_id)).rejects.toMatchObject({ reason: "unavailable" });
    expect((await manager().status(run.run_id)).steps[0]).toMatchObject({ status: "running" });
    expect(backend.started).toHaveLength(1);
  });

  it("keeps the newest runs and drops the oldest finished ones", async () => {
    const { registries, manager } = setup();
    const oneStep = { version: 1, steps: [TWO_STEPS.steps[0]], inputs: TWO_STEPS.inputs };
    await publishWorkflow(registries, oneStep);
    await authorize(manager(), URI);
    const ids: string[] = [];
    for (let i = 0; i < MAX_STORED_RUNS + 2; i++) {
      const run = await manager().start(URI, { subject: `s${i}` });
      expect((await manager().status(run.run_id)).status).toBe("succeeded");
      ids.push(run.run_id);
    }
    const listed = (await manager().list()).runs.map((r) => r.run_id);
    expect(listed).toHaveLength(MAX_STORED_RUNS);
    expect(listed[0]).toBe(ids.at(-1));
    await expect(manager().status(ids[0] as string)).rejects.toMatchObject({ reason: "not_found" });
  });

  it("voids the authorization when a new revision is published", async () => {
    const { registries, backend, manager } = setup(OWNER, 1);
    await publishWorkflow(registries);
    await authorize(manager(), URI);
    const run = await manager().start(URI, { subject: "a fox" });
    const changed = { ...TWO_STEPS, description: "Draw, then restyle (v2)" };
    await publishWorkflow(registries, changed);

    await expect(manager().start(URI, { subject: "a fox" })).rejects.toMatchObject({
      reason: "not_authorized",
    });
    expect((await manager().describe(URI)).authorized).toBe(false);
    // The running run finishes its step but does not start the next one.
    await manager().status(run.run_id);
    const stopped = await manager().status(run.run_id);
    expect(stopped).toMatchObject({
      status: "failed",
      steps: [{ status: "succeeded" }, { status: "failed" }],
    });
    expect(stopped.error).toMatch(/no longer serves the authorized revision/);
    expect(backend.started).toHaveLength(1);
  });

  it("stops a run before its next step when the authorization is revoked", async () => {
    const { registries, backend, manager } = setup(OWNER, 1);
    await publishWorkflow(registries);
    await authorize(manager(), URI);
    const run = await manager().start(URI, { subject: "a fox" });
    expect(await manager().revoke(URI)).toEqual({ revoked: true });
    await manager().status(run.run_id);
    const stopped = await manager().status(run.run_id);
    expect(stopped.status).toBe("failed");
    expect(stopped.error).toMatch(/revoked or replaced/);
    expect(backend.started).toHaveLength(1);
  });

  it("fails a step the command policy refuses without starting a job", async () => {
    const { registries, backend, manager } = setup();
    const capped = {
      version: 1,
      steps: [
        { id: "many", command: "gemini generate", options: { prompt: "x", "num-images": 99 } },
      ],
    };
    await publishWorkflow(registries, capped);
    await authorize(manager(), URI);
    const run = await manager().start(URI);
    expect(run).toMatchObject({ status: "failed", steps: [{ status: "failed" }] });
    expect(run.error).toMatch(/num-images/);
    expect(backend.started).toEqual([]);
  });

  it("enforces max_cost_usd across steps", async () => {
    const { registries, backend, manager } = setup();
    const speech = {
      version: 1,
      inputs: { text: { type: "string", required: true } },
      steps: [
        { id: "one", command: "elevenlabs tts", options: { text: "{{inputs.text}}" } },
        { id: "two", command: "elevenlabs tts", options: { text: "{{inputs.text}}" } },
      ],
    };
    await publishWorkflow(registries, speech);
    const text = "x".repeat(1000);
    const { estimate } = (await import("../src/jobs/job-tools.js")).costPreflight(
      "elevenlabs tts",
      { options: { text }, estimate: true },
    ) as { estimate: { high_usd: number } };
    // Enough for one step, not two.
    await authorize(manager(), URI, { max_cost_usd: estimate.high_usd * 1.5 });
    const run = await manager().start(URI, { text });
    expect(run.steps[0]).toMatchObject({ status: "running", estimate_usd: estimate.high_usd });
    expect(run.spent_usd).toBeCloseTo(estimate.high_usd, 6);
    const after = await manager().status(run.run_id);
    expect(after).toMatchObject({ status: "failed", steps: [{ status: "succeeded" }, {}] });
    expect(after.error).toMatch(/Refusing to run/);
    expect(backend.started).toHaveLength(1);

    // A command with no price cannot run under a budget at all.
    const { registries: r2, backend: b2, manager: m2 } = setup();
    await publishWorkflow(r2);
    await authorize(m2(), URI, { max_cost_usd: 5 });
    const unknown = await m2().start(URI, { subject: "a fox" });
    expect(unknown.status).toBe("failed");
    expect(unknown.error).toMatch(/cost of gemini/);
    expect(b2.started).toEqual([]);
  });

  it("waits for a free job slot instead of failing", async () => {
    const { registries, backend, quota, manager } = setup();
    await publishWorkflow(registries);
    await authorize(manager(), URI);
    quota.busy = true;
    const run = await manager().start(URI, { subject: "a fox" });
    expect(run).toMatchObject({ status: "running", steps: [{ status: "pending" }, {}] });
    expect(run.steps[0]?.note).toMatch(/waiting for a free job slot/);
    quota.busy = false;
    const resumed = await manager().status(run.run_id);
    expect(resumed.steps[0]).toMatchObject({ status: "running" });
    expect(backend.started).toHaveLength(1);
  });

  it("fails the run when a step's job fails, with keys scrubbed", async () => {
    const { registries, backend, manager } = setup();
    await publishWorkflow(registries);
    await authorize(manager(), URI);
    backend.fail = true;
    const run = await manager().start(URI, { subject: "a fox" });
    const failed = await manager().status(run.run_id);
    expect(failed).toMatchObject({ status: "failed", steps: [{ status: "failed" }, {}] });
    expect(JSON.stringify(failed)).not.toContain(GEMINI_KEY);
  });

  it("cancels a run and its current job", async () => {
    const { registries, backend, manager } = setup(OWNER, 5);
    await publishWorkflow(registries);
    await authorize(manager(), URI);
    const run = await manager().start(URI, { subject: "a fox" });
    const canceled = await manager().cancel(run.run_id);
    expect(canceled).toMatchObject({ status: "canceled", steps: [{ status: "canceled" }, {}] });
    expect(backend.canceled).toEqual(backend.started);
    expect((await manager().status(run.run_id)).status).toBe("canceled");
  });

  it("caps active runs per account and hides other accounts' runs", async () => {
    const { registries, manager } = setup(OWNER, 100);
    await publishWorkflow(registries);
    await authorize(manager(), URI);
    const runs = [];
    for (let i = 0; i < MAX_ACTIVE_RUNS; i++)
      runs.push(await manager().start(URI, { subject: "x" }));
    await expect(manager().start(URI, { subject: "x" })).rejects.toMatchObject({
      reason: "busy",
    });
    await expect(manager(OTHER).status(runs[0]?.run_id as string)).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("runs a team skill for a grantee under the grantee's own authorization", async () => {
    const { registries, backend, manager } = setup(OTHER);
    await publishWorkflow(registries, TWO_STEPS, OWNER, "team");
    const teamUri = `skill://team/${OWNER}/studio/SKILL.md`;
    await expect(manager().describe(teamUri)).rejects.toMatchObject({ reason: "not_found" });
    await registries.getByName(OWNER).grant(OWNER, "studio", OTHER);
    await authorize(manager(), teamUri);
    const run = await manager().start(teamUri, { subject: "a fox" });
    expect(backend.started).toHaveLength(1);
    // The owner's authorization list is untouched; the grant can be withdrawn mid-run.
    expect((await manager(OWNER).authorizations()).authorizations).toEqual([]);
    await registries.getByName(OWNER).revoke(OWNER, "studio", OTHER);
    const stopped = await manager().status(run.run_id);
    expect(stopped.status).toBe("failed");
    expect(backend.started).toHaveLength(1);
  });

  it("refuses built-in skills and URIs that are not skill URIs", async () => {
    const { manager } = setup();
    await expect(manager().describe("skill://multix/SKILL.md")).rejects.toMatchObject({
      reason: "not_found",
    });
    await expect(manager().describe("https://example.com/x")).rejects.toMatchObject({
      reason: "invalid",
    });
  });
});

describe("multix_workflow MCP tool", () => {
  const env = fullEnv({ GEMINI_API_KEY: GEMINI_KEY });

  it("is listed with the authoring registry and cannot authorize", async () => {
    const { registries, jobs } = setup("gh-1");
    const deps = { jobs, authoring: { userId: "gh-1", registries } };
    const list = await rpc(env, "tools/list", {}, deps);
    const tool = list.result.tools.find((t: { name: string }) => t.name === "multix_workflow");
    expect(tool.inputSchema.properties.action.enum).toEqual([
      "describe",
      "run",
      "status",
      "cancel",
      "list",
    ]);
    await registries.getByName("gh-1").publish({
      ownerId: "gh-1",
      visibility: "private",
      files: skillFiles("studio", "Image studio", { [WORKFLOW_FILE]: JSON.stringify(TWO_STEPS) }),
    });
    const described = await callTool(
      env,
      "multix_workflow",
      { action: "describe", uri: URI },
      deps,
    );
    expect(described.structuredContent).toMatchObject({ authorized: false });
    const refused = await callTool(
      env,
      "multix_workflow",
      { action: "run", uri: URI, inputs: { subject: "a fox" } },
      deps,
    );
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(
      /^NOT_AUTHORIZED: .*POST \/api\/v1\/workflow-authorizations/,
    );
    const missing = await callTool(env, "multix_workflow", { action: "status" }, deps);
    expect(missing.content[0].text).toMatch(/run_id is required/);
  });

  it("is not offered without the authoring registry", async () => {
    const list = await rpc(env, "tools/list", {}, {});
    expect(list.result.tools.map((t: { name: string }) => t.name)).not.toContain("multix_workflow");
  });
});
