/**
 * The job context of one authenticated request, shared by /mcp and the REST
 * API: the caller's keys, ownership records, the per-job container backend,
 * the job slot caps and the caller's R2 settings. Undefined when the Worker
 * has no job Durable Object bindings (then only the catalog is offered).
 */

import { linkExpirySeconds } from "../accounts/r2-settings.js";
import type { AppContext, AppDeps } from "../app-context.js";
import { type WorkerEnv, jobCapsFrom, outputLinkMaxSecondsFrom } from "../config.js";
import type { ProviderKeys } from "../provider-secret-names.js";
import { MAX_PRESIGN_SECONDS } from "../storage/r2-client.js";
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
    // The job spec carries the effective link lifetime: the account's choice under the operator cap.
    r2Settings: async () => {
      const settings = await app.accounts.r2Settings(userId);
      if (!settings) return null;
      const seconds = linkExpirySeconds(settings, outputLinkMaxSecondsFrom(env));
      const { linkExpirySeconds: _chosen, ...rest } = settings;
      return seconds < MAX_PRESIGN_SECONDS ? { ...rest, linkExpirySeconds: seconds } : rest;
    },
  };
}
