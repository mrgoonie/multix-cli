/**
 * Workflow authorizations and runs of one account, kept in that account's
 * AccountSkills Durable Object next to its skills registry.
 *
 *   wfauth:<ownerId>:<name>  the account allowed running this skill's workflow
 *   wfrun:<runId>            one run; run ids sort by start time
 *
 * A run is saved with a version check, so two requests that read the same run
 * cannot both start its next step (see WorkflowManager).
 */

import type { CostPolicy } from "../../../src/budget/command-cost.js";
import type { RegistryStorage } from "./skill-registry.js";
import type { InputValue, WorkflowManifest } from "./workflow-manifest.js";

/** Runs that have not finished, per account. */
export const MAX_ACTIVE_RUNS = 5;
/** Runs kept per account; the oldest finished ones are dropped first. */
export const MAX_STORED_RUNS = 50;
export const MAX_AUTHORIZATIONS = 200;

export interface WorkflowAuthorization {
  /** Random id: a run keeps it, so a revoked and re-granted authorization does not revive old runs. */
  id: string;
  /** The skill URI it was given for (private or team form). */
  uri: string;
  ownerId: string;
  name: string;
  skillId: string;
  revision: number;
  /** Digest of the manifest file in that revision. */
  digest: string;
  /** Most a whole run may cost, by the price estimates; absent: the server caps only. */
  maxCostUsd?: number;
  costPolicy: CostPolicy;
  grantedAt: number;
}

export type RunStatus = "running" | "succeeded" | "failed" | "canceled";
export type StepStatus =
  | "pending"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "canceled";

export interface StepOutput {
  name: string;
  url: string | null;
  bytes: number;
}

export interface StepState {
  id: string;
  command: string;
  status: StepStatus;
  jobId?: string;
  outputs?: StepOutput[];
  /** High end of the step's price estimate, counted against maxCostUsd. */
  estimateUsd?: number | null;
  error?: string;
  note?: string;
}

export interface WorkflowRun {
  id: string;
  /** The account running it (the store's own account). */
  userId: string;
  ownerId: string;
  name: string;
  uri: string;
  skillId: string;
  revision: number;
  digest: string;
  authorizationId: string;
  maxCostUsd?: number;
  costPolicy: CostPolicy;
  manifest: WorkflowManifest;
  inputs: Record<string, InputValue>;
  status: RunStatus;
  /** Index of the step that runs next or now. */
  step: number;
  steps: StepState[];
  spentUsd: number;
  error?: string;
  /** Held while one request starts the current step's job. */
  lease?: { id: string; until: number };
  version: number;
  createdAt: number;
  updatedAt: number;
}

export const authKey = (ownerId: string, name: string) => `wfauth:${ownerId}:${name}`;
const runKey = (runId: string) => `wfrun:${runId}`;
export const RUN_ID_RE = /^wfr_[0-9a-z]{9}_[0-9a-f]{16}$/;

export function newRunId(now: number): string {
  const random = crypto.getRandomValues(new Uint8Array(8));
  const hex = [...random].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `wfr_${now.toString(36).padStart(9, "0")}_${hex}`;
}

export const isFinished = (run: WorkflowRun) => run.status !== "running";

export class WorkflowStore {
  constructor(private readonly storage: RegistryStorage) {}

  async authorization(ownerId: string, name: string): Promise<WorkflowAuthorization | null> {
    return (await this.storage.get<WorkflowAuthorization>(authKey(ownerId, name))) ?? null;
  }

  async authorizations(): Promise<WorkflowAuthorization[]> {
    const rows = await this.storage.list<WorkflowAuthorization>({
      prefix: "wfauth:",
      limit: MAX_AUTHORIZATIONS,
    });
    return [...rows.values()];
  }

  /** Store or replace the authorization for one skill; false when the account holds too many. */
  async putAuthorization(auth: WorkflowAuthorization): Promise<boolean> {
    const key = authKey(auth.ownerId, auth.name);
    if (!(await this.storage.get(key))) {
      const rows = await this.storage.list({ prefix: "wfauth:", limit: MAX_AUTHORIZATIONS });
      if (rows.size >= MAX_AUTHORIZATIONS) return false;
    }
    await this.storage.put({ [key]: auth });
    return true;
  }

  async deleteAuthorization(ownerId: string, name: string): Promise<boolean> {
    return (await this.storage.delete([authKey(ownerId, name)])) > 0;
  }

  async run(runId: string): Promise<WorkflowRun | null> {
    if (!RUN_ID_RE.test(runId)) return null;
    return (await this.storage.get<WorkflowRun>(runKey(runId))) ?? null;
  }

  /** Newest first. */
  async runs(limit = MAX_STORED_RUNS): Promise<WorkflowRun[]> {
    const rows = await this.storage.list<WorkflowRun>({ prefix: "wfrun:", reverse: true, limit });
    return [...rows.values()];
  }

  /**
   * Store a new run. Refused (false) while MAX_ACTIVE_RUNS runs are active;
   * beyond MAX_STORED_RUNS the oldest finished runs are dropped.
   */
  async createRun(run: WorkflowRun): Promise<boolean> {
    const all = await this.storage.list<WorkflowRun>({ prefix: "wfrun:" });
    const runs = [...all.values()];
    if (runs.filter((r) => !isFinished(r)).length >= MAX_ACTIVE_RUNS) return false;
    const drop = runs
      .filter(isFinished)
      .slice(0, Math.max(0, runs.length + 1 - MAX_STORED_RUNS))
      .map((r) => runKey(r.id));
    if (drop.length > 0) await this.storage.delete(drop);
    await this.storage.put({ [runKey(run.id)]: { ...run, version: 1 } });
    return true;
  }

  /**
   * Save `run` if the stored run still has `run.version`; the saved run has
   * the next version. Null when another request saved it first.
   */
  async saveRun(run: WorkflowRun): Promise<WorkflowRun | null> {
    const stored = await this.storage.get<WorkflowRun>(runKey(run.id));
    if (!stored || stored.version !== run.version) return null;
    const next = { ...run, version: run.version + 1 };
    await this.storage.put({ [runKey(run.id)]: next });
    return next;
  }
}
