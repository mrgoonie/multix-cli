/**
 * The job context of one authenticated request, shared by /mcp and the REST
 * API: the caller's keys, ownership records, the per-job container backend,
 * the job slot caps and the caller's R2 settings. Undefined when the Worker
 * has no job Durable Object bindings (then only the catalog is offered).
 */

import type { AppContext, AppDeps } from "../app-context.js";
import { type WorkerEnv, jobCapsFrom } from "../config.js";
import type { ProviderKeys } from "../provider-secret-names.js";
import { durableJobQuota } from "./account-job-quota.js";
import type { JobToolsContext } from "./job-runner.js";
import { JobStore, durableJobBackend } from "./job-store.js";

export function jobsContextFor(
  env: WorkerEnv,
  app: AppContext,
  userId: string,
  keys: ProviderKeys,
  deps: AppDeps,
): JobToolsContext | undefined {
  // The CLI runner needs both Durable Objects: the per-job container and the job slots.
  if (!env.MULTIX_JOBS || !env.MULTIX_JOB_QUOTA) return undefined;
  const caps = jobCapsFrom(env);
  return {
    userId,
    keys,
    store: new JobStore(env.ACCOUNTS_KV),
    backend: deps.jobBackend ?? durableJobBackend(env.MULTIX_JOBS),
    quota: durableJobQuota(env.MULTIX_JOB_QUOTA, caps),
    caps,
    r2Settings: () => app.accounts.r2Settings(userId),
  };
}
