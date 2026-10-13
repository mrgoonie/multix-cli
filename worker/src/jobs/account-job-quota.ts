/**
 * Per-account cap on jobs that run at the same time. One small Durable Object
 * per account (`MULTIX_JOB_QUOTA.getByName(userId)`) holds that account's
 * active job slots, so the count is strongly consistent: a Durable Object
 * handles one call at a time, and its storage reads and writes cannot
 * interleave with another call.
 *
 * A slot is taken before the job starts and given back when the job's Durable
 * Object records a final state (done, failed, canceled, timed out) or when the
 * Worker could not start the job. Every slot also carries a lease: a slot that
 * was never given back (crash, lost RPC) frees itself when the lease expires.
 */

import { DurableObject } from "cloudflare:workers";
import { JOB_SLOT_LEASE_MS } from "./job-protocol.js";

/** Jobs one account may have running at the same time. */
export const MAX_ACTIVE_JOBS_PER_ACCOUNT = 2;

export const ACCOUNT_BUSY_ERROR = `busy: you already have ${MAX_ACTIVE_JOBS_PER_ACCOUNT} running jobs; wait for one to finish or stop it with multix_job_cancel`;

/** Job id -> lease expiry (epoch ms). */
export type JobSlots = Record<string, number>;

/** Drop expired leases, then take a slot for `jobId` when one is free. Pure. */
export function takeSlot(
  slots: JobSlots,
  jobId: string,
  now: number,
  limit = MAX_ACTIVE_JOBS_PER_ACCOUNT,
  leaseMs = JOB_SLOT_LEASE_MS,
): { ok: boolean; slots: JobSlots } {
  const live: JobSlots = {};
  for (const [id, expiresAt] of Object.entries(slots)) {
    if (expiresAt > now) live[id] = expiresAt;
  }
  if (live[jobId] !== undefined) return { ok: true, slots: live };
  if (Object.keys(live).length >= limit) return { ok: false, slots: live };
  return { ok: true, slots: { ...live, [jobId]: now + leaseMs } };
}

const SLOTS_KEY = "slots";

export class AccountJobQuota extends DurableObject {
  /** Take a slot for `jobId`; false when the account already runs the maximum. */
  async acquire(jobId: string): Promise<boolean> {
    const current = (await this.ctx.storage.get<JobSlots>(SLOTS_KEY)) ?? {};
    const { ok, slots } = takeSlot(current, jobId, Date.now());
    await this.ctx.storage.put(SLOTS_KEY, slots);
    return ok;
  }

  /** Give back the slot of `jobId` (no-op when it was already released or expired). */
  async release(jobId: string): Promise<void> {
    const slots = (await this.ctx.storage.get<JobSlots>(SLOTS_KEY)) ?? {};
    if (slots[jobId] === undefined) return;
    delete slots[jobId];
    await this.ctx.storage.put(SLOTS_KEY, slots);
  }
}

/** RPC surface of AccountJobQuota. */
export interface AccountJobQuotaStub {
  acquire(jobId: string): Promise<boolean>;
  release(jobId: string): Promise<void>;
}

export interface JobQuotaNamespace {
  getByName(name: string): AccountJobQuotaStub;
}

/** What the Worker and the job Durable Object use: slots addressed by account. */
export interface JobQuota {
  acquire(userId: string, jobId: string): Promise<boolean>;
  release(userId: string, jobId: string): Promise<void>;
}

export function durableJobQuota(namespace: JobQuotaNamespace): JobQuota {
  return {
    acquire: (userId, jobId) => namespace.getByName(userId).acquire(jobId),
    release: (userId, jobId) => namespace.getByName(userId).release(jobId),
  };
}
