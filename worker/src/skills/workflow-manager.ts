/**
 * Run a skill's workflow (`multix.workflow.json`) for the calling account,
 * shared by the MCP tool (multix_workflow) and the REST API
 * (/api/v1/workflows, /workflow-authorizations, /workflow-runs).
 *
 * A run starts only under an authorization the account gave over REST for
 * exactly the skill id, revision and manifest digest it runs, and every step
 * re-checks that authorization and the served skill before its job starts.
 * Each step is one multix_run job: same command policy, caps, URL guard,
 * spend guard and cost check. A run advances when it is read: the reader
 * collects the finished step's outputs and starts the next step.
 */

import {
  type CostPolicy,
  checkBudget,
  estimateCommand,
  parseCostPolicy,
} from "../../../src/budget/command-cost.js";
import { MultixError } from "../../../src/core/errors.js";
import { type Limits, secretValues } from "../config.js";
import { isTerminal } from "../jobs/job-protocol.js";
import {
  JobCapacityError,
  JobNotFoundError,
  JobRunner,
  type JobToolsContext,
} from "../jobs/job-runner.js";
import { prepareRun } from "../jobs/run-argv-builder.js";
import { assertSpendGuard } from "../jobs/run-option-caps.js";
import { sanitizeText } from "../redaction.js";
import type { SkillAuthoringStub } from "./account-skills.js";
import { locate } from "./skill-catalog.js";
import { decodeText } from "./skill-files.js";
import { skillUri } from "./skill-manager.js";
import type { Skill } from "./skill-types.js";
import {
  WORKFLOW_FILE,
  type WorkflowManifest,
  WorkflowManifestError,
  parseWorkflowManifest,
  renderStep,
  validateRunInputs,
} from "./workflow-manifest.js";
import {
  MAX_ACTIVE_RUNS,
  MAX_AUTHORIZATIONS,
  type StepState,
  type StepStatus,
  type WorkflowAuthorization,
  type WorkflowRun,
  isFinished,
  newRunId,
} from "./workflow-store.js";

/** How long one request may take to start a step's job before another may retry it. */
export const STEP_LEASE_MS = 2 * 60 * 1000;
/** Highest max_cost_usd an authorization may carry. */
export const MAX_WORKFLOW_COST_USD = 10_000;

export type WorkflowErrorReason =
  | "invalid"
  | "not_found"
  | "not_authorized"
  | "conflict"
  | "busy"
  | "unavailable";

/** A refused workflow call; the message is safe to show the caller. */
export class WorkflowError extends MultixError {
  constructor(
    message: string,
    readonly reason: WorkflowErrorReason,
  ) {
    super(message, reason.toUpperCase());
    this.name = "WorkflowError";
  }
}

export interface WorkflowContext {
  userId: string;
  registries: { getByName(accountId: string): SkillAuthoringStub };
  /** The caller's job context; runs cannot start without it. */
  jobs?: JobToolsContext;
  limits: Limits;
  now?: () => number;
}

export interface AuthorizeInput {
  revision: number;
  digest: string;
  max_cost_usd?: number;
  cost_policy?: string;
}

interface SkillRef {
  ownerId: string;
  name: string;
  uri: string;
}

interface LoadedWorkflow extends SkillRef {
  skill: Skill;
  revision: number;
  digest: string;
  manifest: WorkflowManifest;
}

const iso = (ms: number) => new Date(ms).toISOString();
const usd = (n: number) => Math.round(n * 1e6) / 1e6;

function matches(auth: WorkflowAuthorization | null, loaded: LoadedWorkflow): boolean {
  return (
    auth !== null &&
    auth.skillId === loaded.skill.id &&
    auth.revision === loaded.revision &&
    auth.digest === loaded.digest
  );
}

function authorizationView(auth: WorkflowAuthorization) {
  return {
    authorization_id: auth.id,
    uri: auth.uri,
    owner: auth.ownerId,
    skill: auth.name,
    revision: auth.revision,
    digest: auth.digest,
    max_cost_usd: auth.maxCostUsd ?? null,
    cost_policy: auth.costPolicy,
    granted_at: iso(auth.grantedAt),
  };
}

function stepView(step: StepState) {
  return {
    id: step.id,
    command: step.command,
    status: step.status,
    job_id: step.jobId ?? null,
    outputs: step.outputs ?? [],
    estimate_usd: step.estimateUsd ?? null,
    ...(step.error ? { error: step.error } : {}),
    ...(step.note ? { note: step.note } : {}),
  };
}

export function runView(run: WorkflowRun) {
  return {
    run_id: run.id,
    status: run.status,
    uri: run.uri,
    revision: run.revision,
    digest: run.digest,
    inputs: run.inputs,
    current_step: run.status === "running" ? (run.steps[run.step]?.id ?? null) : null,
    steps: run.steps.map(stepView),
    max_cost_usd: run.maxCostUsd ?? null,
    spent_usd: usd(run.spentUsd),
    ...(run.error ? { error: run.error } : {}),
    created_at: iso(run.createdAt),
    updated_at: iso(run.updatedAt),
    ...(isFinished(run)
      ? {}
      : { next: { tool: "multix_workflow", arguments: { action: "status", run_id: run.id } } }),
  };
}

const runSummary = (run: WorkflowRun) => ({
  run_id: run.id,
  status: run.status,
  uri: run.uri,
  current_step: run.status === "running" ? (run.steps[run.step]?.id ?? null) : null,
  created_at: iso(run.createdAt),
});

export class WorkflowManager {
  private readonly now: () => number;

  constructor(private readonly ctx: WorkflowContext) {
    this.now = ctx.now ?? Date.now;
  }

  private get me(): string {
    return this.ctx.userId;
  }

  /** The caller's own object: its authorizations and runs. */
  private get own(): SkillAuthoringStub {
    return this.ctx.registries.getByName(this.me);
  }

  private runner(): JobRunner {
    if (!this.ctx.jobs) {
      throw new WorkflowError("Jobs are not available on this server", "unavailable");
    }
    return new JobRunner(this.ctx.jobs);
  }

  /** `skill://private/<name>[/…]` or `skill://team/<owner>/<name>[/…]` → owner and name. */
  private ref(uri: string): SkillRef {
    let located: ReturnType<typeof locate>;
    try {
      located = locate(uri);
    } catch {
      throw new WorkflowError(
        "expected a skill URI: skill://private/<name>/SKILL.md or skill://team/<owner>/<name>/SKILL.md",
        "invalid",
      );
    }
    if (located.kind === "builtin") {
      throw new WorkflowError("built-in skills have no workflow", "not_found");
    }
    const ownerId = located.kind === "team" ? located.ownerId : this.me;
    return {
      ownerId,
      name: located.name,
      uri: skillUri({ name: located.name, ownerId, visibility: located.kind }),
    };
  }

  /** The served revision's manifest, as the caller may read it. */
  private async load(ref: SkillRef): Promise<LoadedWorkflow> {
    const registry = this.ctx.registries.getByName(ref.ownerId);
    const served = await registry.served(ref.ownerId, this.me, ref.name);
    if (!served) throw new WorkflowError(`no skill is served at ${ref.uri}`, "not_found");
    const file = served.revision.files.find((f) => f.path === WORKFLOW_FILE);
    if (!file) throw new WorkflowError(`${ref.uri} has no ${WORKFLOW_FILE}`, "not_found");
    const read = await registry.readFile(ref.ownerId, this.me, ref.name, WORKFLOW_FILE);
    if (!read || read.file.digest !== file.digest) {
      throw new WorkflowError("the skill changed while it was read; retry", "conflict");
    }
    let manifest: WorkflowManifest;
    try {
      manifest = parseWorkflowManifest(decodeText(read.bytes) ?? "");
    } catch (error) {
      if (!(error instanceof WorkflowManifestError)) throw error;
      throw new WorkflowError(`${WORKFLOW_FILE}: ${error.message}`, "invalid");
    }
    return {
      ...ref,
      skill: served.skill,
      revision: served.revision.revision,
      digest: file.digest,
      manifest,
    };
  }

  /** The served workflow, and whether the caller authorized exactly it. */
  async describe(uri: string) {
    const loaded = await this.load(this.ref(uri));
    const auth = await this.own.workflowAuthorization(this.me, loaded.ownerId, loaded.name);
    const authorized = matches(auth, loaded);
    return {
      uri: loaded.uri,
      owner: loaded.ownerId,
      skill: loaded.name,
      revision: loaded.revision,
      digest: loaded.digest,
      description: loaded.manifest.description ?? null,
      inputs: loaded.manifest.inputs,
      steps: loaded.manifest.steps,
      authorized,
      authorization: auth ? authorizationView(auth) : null,
      ...(authorized
        ? {}
        : {
            authorize: {
              note: "Running needs your authorization for this revision and digest. Review the steps, then authorize over REST with an API key from /dashboard; MCP cannot authorize.",
              method: "POST",
              path: "/api/v1/workflow-authorizations",
              body: { uri: loaded.uri, revision: loaded.revision, digest: loaded.digest },
            },
          }),
    };
  }

  /** Allow the caller to run the served workflow; revision and digest must be the served ones. */
  async authorize(uri: string, input: AuthorizeInput) {
    const loaded = await this.load(this.ref(uri));
    if (input.revision !== loaded.revision || input.digest !== loaded.digest) {
      throw new WorkflowError(
        `${loaded.uri} serves revision ${loaded.revision} with workflow digest ${loaded.digest}; review that one and authorize it`,
        "conflict",
      );
    }
    const max = input.max_cost_usd;
    if (max !== undefined && !(Number.isFinite(max) && max >= 0 && max <= MAX_WORKFLOW_COST_USD)) {
      throw new WorkflowError(`max_cost_usd must be 0 to ${MAX_WORKFLOW_COST_USD}`, "invalid");
    }
    let costPolicy: CostPolicy;
    try {
      costPolicy = parseCostPolicy(input.cost_policy);
    } catch (error) {
      throw new WorkflowError((error as Error).message, "invalid");
    }
    const auth: WorkflowAuthorization = {
      id: `wfa_${crypto.randomUUID()}`,
      uri: loaded.uri,
      ownerId: loaded.ownerId,
      name: loaded.name,
      skillId: loaded.skill.id,
      revision: loaded.revision,
      digest: loaded.digest,
      ...(max !== undefined ? { maxCostUsd: max } : {}),
      costPolicy,
      grantedAt: this.now(),
    };
    if (!(await this.own.putWorkflowAuthorization(this.me, auth))) {
      throw new WorkflowError(
        `an account may hold at most ${MAX_AUTHORIZATIONS} workflow authorizations`,
        "invalid",
      );
    }
    return { authorization: authorizationView(auth) };
  }

  async authorizations() {
    const rows = await this.own.workflowAuthorizations(this.me);
    return { authorizations: rows.map(authorizationView) };
  }

  /** Withdraw an authorization; runs under it stop before their next step. */
  async revoke(uri: string) {
    const ref = this.ref(uri);
    return { revoked: await this.own.deleteWorkflowAuthorization(this.me, ref.ownerId, ref.name) };
  }

  /** Start a run of an authorized workflow and its first step. */
  async start(uri: string, inputs: Record<string, unknown> = {}) {
    this.runner();
    const loaded = await this.load(this.ref(uri));
    const auth = await this.own.workflowAuthorization(this.me, loaded.ownerId, loaded.name);
    if (!auth || !matches(auth, loaded)) {
      throw new WorkflowError(
        `${loaded.uri} revision ${loaded.revision} (workflow digest ${loaded.digest}) is not authorized for your account. Review it with describe, then authorize it over REST: POST /api/v1/workflow-authorizations with an API key from /dashboard.`,
        "not_authorized",
      );
    }
    const values = validateRunInputs(loaded.manifest, inputs);
    const at = this.now();
    const run: WorkflowRun = {
      id: newRunId(at),
      userId: this.me,
      ownerId: loaded.ownerId,
      name: loaded.name,
      uri: loaded.uri,
      skillId: loaded.skill.id,
      revision: loaded.revision,
      digest: loaded.digest,
      authorizationId: auth.id,
      ...(auth.maxCostUsd !== undefined ? { maxCostUsd: auth.maxCostUsd } : {}),
      costPolicy: auth.costPolicy,
      manifest: loaded.manifest,
      inputs: values,
      status: "running",
      step: 0,
      steps: loaded.manifest.steps.map((s) => ({
        id: s.id,
        command: s.command,
        status: "pending",
      })),
      spentUsd: 0,
      version: 1,
      createdAt: at,
      updatedAt: at,
    };
    if (!(await this.own.createWorkflowRun(this.me, run))) {
      throw new WorkflowError(
        `at most ${MAX_ACTIVE_RUNS} workflow runs may be active; wait for one or cancel it`,
        "busy",
      );
    }
    return runView(await this.advance(run));
  }

  private async getRun(runId: string): Promise<WorkflowRun> {
    const run = await this.own.workflowRun(this.me, runId);
    if (!run) throw new WorkflowError("Workflow run not found", "not_found");
    return run;
  }

  /** Read a run, advancing it first: collect a finished step and start the next. */
  async status(runId: string) {
    const run = await this.getRun(runId);
    return runView(isFinished(run) ? run : await this.advance(run));
  }

  async cancel(runId: string) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const run = await this.getRun(runId);
      if (isFinished(run)) return runView(run);
      const state = run.steps[run.step] as StepState;
      const jobId = state.jobId;
      state.status = "canceled";
      run.status = "canceled";
      run.updatedAt = this.now();
      run.lease = undefined;
      const saved = await this.own.saveWorkflowRun(this.me, run);
      if (!saved) continue;
      if (jobId)
        await this.runner()
          .cancel(jobId)
          .catch(() => undefined);
      return runView(saved);
    }
    throw new WorkflowError("the run kept changing; retry", "conflict");
  }

  async list() {
    const [runs, auths] = await Promise.all([
      this.own.workflowRuns(this.me),
      this.own.workflowAuthorizations(this.me),
    ]);
    return { runs: runs.map(runSummary), authorizations: auths.map(authorizationView) };
  }

  /** Move the run forward until a step is in flight or the run is finished. */
  private async advance(initial: WorkflowRun): Promise<WorkflowRun> {
    let run = initial;
    while (run.status === "running") {
      const state = run.steps[run.step] as StepState;
      const before = run.step;
      const next = state.jobId ? await this.follow(run, state.jobId) : await this.startStep(run);
      // Start the next step right away only when this call finished the previous one.
      if (next.status !== "running" || next.step === before || next.steps[next.step]?.jobId) {
        return next;
      }
      run = next;
    }
    return run;
  }

  private async reload(run: WorkflowRun): Promise<WorkflowRun> {
    return (await this.own.workflowRun(this.me, run.id)) ?? run;
  }

  private fail(run: WorkflowRun, state: StepState, status: StepStatus, error: string): void {
    state.status = status;
    state.error = error;
    run.status = "failed";
    run.error = `step "${state.id}" ${status === "failed" ? "failed" : status}: ${error}`;
  }

  /** Check on the current step's job; on success record its outputs and move to the next step. */
  private async follow(run: WorkflowRun, jobId: string): Promise<WorkflowRun> {
    const state = run.steps[run.step] as StepState;
    let payload: Record<string, unknown>;
    try {
      payload = await this.runner().status(jobId);
    } catch (error) {
      if (!(error instanceof JobNotFoundError)) throw error;
      payload = { status: "failed", error: "the step's job record is gone", outputs: [] };
    }
    const status = payload.status as StepStatus;
    if (!isTerminal(status as never)) {
      state.status = "running";
      return run;
    }
    state.outputs = (payload.outputs as StepState["outputs"]) ?? [];
    if (status === "succeeded") {
      state.status = "succeeded";
      run.step += 1;
      if (run.step >= run.steps.length) run.status = "succeeded";
    } else {
      this.fail(run, state, status, (payload.error as string | undefined) ?? `the job ${status}`);
    }
    run.updatedAt = this.now();
    return (await this.own.saveWorkflowRun(this.me, run)) ?? (await this.reload(run));
  }

  /** Stop unless the authorization and the served skill are still the ones the run started under. */
  private async recheck(run: WorkflowRun): Promise<void> {
    const auth = await this.own.workflowAuthorization(this.me, run.ownerId, run.name);
    if (!auth || auth.id !== run.authorizationId) {
      throw new WorkflowError(
        "the authorization this run started under was revoked or replaced",
        "not_authorized",
      );
    }
    const served = await this.ctx.registries
      .getByName(run.ownerId)
      .served(run.ownerId, this.me, run.name);
    const file = served?.revision.files.find((f) => f.path === WORKFLOW_FILE);
    if (
      !served ||
      served.skill.id !== run.skillId ||
      served.revision.revision !== run.revision ||
      file?.digest !== run.digest
    ) {
      throw new WorkflowError(
        "the skill no longer serves the authorized revision to you; review and authorize the served one, then start again",
        "not_authorized",
      );
    }
  }

  /**
   * Start the current step's job under a lease, so two readers of the same
   * run cannot both start it. A busy job slot leaves the step pending.
   */
  private async startStep(run: WorkflowRun): Promise<WorkflowRun> {
    const now = this.now();
    if (run.lease && run.lease.until > now) return run;
    const leasing = structuredClone(run);
    leasing.lease = { id: crypto.randomUUID(), until: now + STEP_LEASE_MS };
    (leasing.steps[leasing.step] as StepState).status = "starting";
    const leased = await this.own.saveWorkflowRun(this.me, leasing);
    if (!leased) return this.reload(run);

    const runner = this.runner();
    const state = leased.steps[leased.step] as StepState;
    const definition = leased.manifest.steps[leased.step];
    state.note = undefined;
    try {
      if (!definition) throw new WorkflowError("the run has no such step", "invalid");
      await this.recheck(leased);
      const outputs = Object.fromEntries(
        leased.steps.slice(0, leased.step).map((s) => [s.id, (s.outputs ?? []).map((o) => o.url)]),
      );
      const request = renderStep(definition, leased.inputs, outputs);
      const prepared = prepareRun(request, this.ctx.limits);
      const remaining =
        leased.maxCostUsd === undefined
          ? undefined
          : Math.max(0, leased.maxCostUsd - leased.spentUsd);
      assertSpendGuard(prepared.command, prepared.uncappedSpend, this.ctx.limits, remaining);
      let estimateUsd: number | null = null;
      if (remaining !== undefined) {
        // The estimate cannot see an uncapped part, so only a proven ceiling counts then.
        const estimate = estimateCommand(prepared.command, request.options ?? {});
        checkBudget(estimate, remaining, prepared.uncappedSpend ? "strict" : leased.costPolicy);
        estimateUsd = estimate.high_usd;
      }
      const payload = await runner.run(prepared, 0);
      state.jobId = payload.job_id as string;
      state.status = payload.status as StepStatus;
      state.estimateUsd = estimateUsd;
      leased.spentUsd += estimateUsd ?? 0;
    } catch (error) {
      if (error instanceof JobCapacityError) {
        state.status = "pending";
        state.note = `waiting for a free job slot (${error.message}); read the run again later`;
      } else if (error instanceof MultixError) {
        const secrets = this.ctx.jobs ? secretValues(this.ctx.jobs.keys) : [];
        this.fail(leased, state, "failed", sanitizeText(error.message, secrets));
      } else {
        state.status = "pending";
        leased.lease = undefined;
        await this.own.saveWorkflowRun(this.me, leased);
        throw error;
      }
    }
    leased.lease = undefined;
    leased.updatedAt = this.now();
    const saved = await this.own.saveWorkflowRun(this.me, leased);
    if (saved) return saved;
    // Canceled while the job started: stop the job too.
    if (state.jobId) await runner.cancel(state.jobId).catch(() => undefined);
    return this.reload(run);
  }
}
