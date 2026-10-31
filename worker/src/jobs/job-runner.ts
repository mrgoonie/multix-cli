/**
 * `multix_run` / `multix_job_status` / `multix_job_cancel` behind the MCP
 * tools: record ownership, hand the job to its Durable Object, wait up to
 * `wait_seconds` for it, and shape the result for the caller with every
 * credential value scrubbed from the CLI's output.
 */

import { ValidationError } from "../../../src/core/errors.js";
import { DEFAULT_R2_PREFIX, type R2Settings, r2Prefix } from "../accounts/r2-settings.js";
import type { ProviderKeys } from "../provider-secret-names.js";
import { NON_SECRET_NAMES } from "../provider-secret-names.js";
import { type JobCaps, type JobQuota, quotaError } from "./account-job-quota.js";
import { GROUP_KEYS } from "./cli-command-policy.js";
import {
  JOB_TIMEOUT_MS,
  type JobSpec,
  type JobView,
  SERVER_AT_CAPACITY_ERROR,
  isTerminal,
} from "./job-protocol.js";
import type { JobBackend, JobStore } from "./job-store.js";
import type { PreparedRun } from "./run-argv-builder.js";

/**
 * `wait_seconds` bounds the whole multix_run call, container start included,
 * so a call returns within about MAX_WAIT_SECONDS + one status read (under
 * the ~60 s many MCP clients allow).
 */
export const MAX_WAIT_SECONDS = 40;
export const DEFAULT_WAIT_SECONDS = 25;
const POLL_INTERVAL_MS = 2_000;

export const NO_STORAGE_NOTE =
  "R2 storage is not configured: configure R2 in /dashboard to receive output files. Provider URLs printed by the CLI are returned unchanged.";

export interface JobToolsContext {
  userId: string;
  /** The caller's decrypted provider keys. */
  keys: ProviderKeys;
  store: JobStore;
  backend: JobBackend;
  /** Per-account and server-wide active job slots. */
  quota: JobQuota;
  /** The caps `quota` enforces, for messages and tool descriptions. */
  caps: JobCaps;
  r2Settings(): Promise<R2Settings | null>;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Thrown when the account or the server already runs as many jobs as allowed. */
export class JobCapacityError extends ValidationError {}

/** Thrown for a job that does not exist or belongs to another account. */
export class JobNotFoundError extends ValidationError {
  constructor() {
    super("Job not found");
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** R2 key prefix for a job's outputs: `<directory>/<sha256(userId)[0:16]>/<jobId>`, directory `multix` by default. */
export async function outputKeyPrefix(
  userId: string,
  jobId: string,
  directory: string = DEFAULT_R2_PREFIX,
): Promise<string> {
  return `${directory}/${(await sha256Hex(userId)).slice(0, 16)}/${jobId}`;
}

/** Only the keys the command's providers read. */
export function jobEnv(groups: readonly string[], keys: ProviderKeys): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of groups.flatMap((group) => GROUP_KEYS[group] ?? [])) {
    const value = keys[name]?.trim();
    if (value) env[name] = value;
  }
  return env;
}

/** Values to scrub from anything returned: provider keys and R2 credentials. */
function scrubList(keys: ProviderKeys, r2: R2Settings | null): string[] {
  const values = Object.entries(keys)
    .filter(([name]) => !NON_SECRET_NAMES.has(name as keyof ProviderKeys))
    .map(([, value]) => value?.trim() ?? "");
  if (r2) values.push(r2.secretAccessKey, r2.accessKeyId);
  return values.filter((v) => v.length >= 8).sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
}

export function jobPayload(
  jobId: string,
  view: JobView,
  secrets: readonly string[],
): Record<string, unknown> {
  const result = view.result;
  const payload: Record<string, unknown> = {
    job_id: jobId,
    status: view.status,
    outputs: result?.outputs ?? [],
    stdout: redactSecrets(result?.stdout ?? "", secrets),
    stderr_tail: redactSecrets(result?.stderrTail ?? "", secrets),
    exit_code: result?.exitCode ?? null,
  };
  const error = view.error ?? result?.error;
  if (error) payload.error = redactSecrets(error, secrets);
  if (result?.note) payload.note = result.note;
  if (!isTerminal(view.status)) {
    payload.next = { tool: "multix_job_status", arguments: { job_id: jobId } };
  }
  return payload;
}

export class JobRunner {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly ctx: JobToolsContext) {
    this.sleep = ctx.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = ctx.now ?? Date.now;
  }

  /** `jobId` lets a caller record the id before the job starts (workflow steps). */
  async run(
    prepared: PreparedRun,
    waitSeconds: number,
    jobId: string = crypto.randomUUID(),
  ): Promise<Record<string, unknown>> {
    const r2 = await this.ctx.r2Settings();
    const spec: JobSpec = {
      jobId,
      argv: prepared.argv,
      env: jobEnv(prepared.keyGroups, this.ctx.keys),
      inputs: prepared.inputs,
      timeoutMs: JOB_TIMEOUT_MS,
    };
    if (r2)
      spec.upload = { r2, keyPrefix: await outputKeyPrefix(this.ctx.userId, jobId, r2Prefix(r2)) };
    const { userId } = this.ctx;
    const deadline = this.now() + waitSeconds * 1000;
    const acquired = await this.ctx.quota.acquire(userId, jobId);
    if (acquired !== "ok") throw new JobCapacityError(quotaError(acquired, this.ctx.caps));
    let view: JobView;
    try {
      await this.ctx.store.create(jobId, {
        userId,
        command: prepared.command,
        createdAt: this.now(),
      });
      view = await this.ctx.backend.start(jobId, spec, userId, prepared.command);
    } catch (error) {
      // The job Durable Object normally gives the slot back; here it may never have run.
      await this.ctx.quota.release(userId, jobId).catch(() => undefined);
      throw error;
    }
    if (view.status === "failed" && view.error === SERVER_AT_CAPACITY_ERROR) {
      throw new JobCapacityError(SERVER_AT_CAPACITY_ERROR);
    }
    while (!isTerminal(view.status) && this.now() < deadline) {
      await this.sleep(Math.min(POLL_INTERVAL_MS, deadline - this.now()));
      view = (await this.ctx.backend.status(jobId)) ?? view;
    }
    const payload = jobPayload(jobId, view, scrubList(this.ctx.keys, r2));
    if (!r2 && payload.note === undefined) payload.note = NO_STORAGE_NOTE;
    return payload;
  }

  async status(jobId: string): Promise<Record<string, unknown>> {
    await this.assertOwned(jobId);
    const view = await this.ctx.backend.status(jobId);
    if (!view) throw new JobNotFoundError();
    return jobPayload(jobId, view, scrubList(this.ctx.keys, await this.ctx.r2Settings()));
  }

  async cancel(jobId: string): Promise<Record<string, unknown>> {
    await this.assertOwned(jobId);
    const view = await this.ctx.backend.cancel(jobId);
    if (!view) throw new JobNotFoundError();
    return jobPayload(jobId, view, scrubList(this.ctx.keys, await this.ctx.r2Settings()));
  }

  private async assertOwned(jobId: string): Promise<void> {
    if (!(await this.ctx.store.ownedBy(jobId, this.ctx.userId))) throw new JobNotFoundError();
  }
}
