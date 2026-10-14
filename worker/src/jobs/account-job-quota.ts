/**
 * Caps on jobs that run at the same time: per account and server-wide. One
 * small Durable Object per account (`MULTIX_JOB_QUOTA.getByName(userId)`)
 * holds that account's active job slots, and one more under SERVER_SLOTS_NAME
 * holds every running job, so both counts are strongly consistent: a Durable
 * Object handles one call at a time, and its storage reads and writes cannot
 * interleave with another call.
 *
 * A job takes its account slot, then its server slot, before it starts, and
 * gives both back when the job's Durable Object records a final state (done,
 * failed, canceled, timed out) or when the Worker could not start the job.
 * Every slot also carries a lease: a slot that was never given back (crash,
 * lost RPC) frees itself when the lease expires.
 *
 * The caps are the Worker vars MULTIX_MAX_JOBS_PER_ACCOUNT and
 * MULTIX_MAX_JOBS_TOTAL (config.ts jobCapsFrom). The container `max_instances`
 * in wrangler.jsonc stays the platform ceiling above MULTIX_MAX_JOBS_TOTAL.
 */

import { DurableObject } from "cloudflare:workers";
import { JOB_SLOT_LEASE_MS, SERVER_AT_CAPACITY_ERROR } from "./job-protocol.js";

/** Default jobs one account may have running at the same time. */
export const MAX_ACTIVE_JOBS_PER_ACCOUNT = 2;
/** Default jobs the whole server may run at the same time (the container `max_instances`). */
export const MAX_ACTIVE_JOBS_TOTAL = 10;

/**
 * Durable Object name of the server-wide slots. Account ids are `gh-<id>`, so
 * this name never collides with an account's own object.
 */
export const SERVER_SLOTS_NAME = "server:all";

export interface JobCaps {
  perAccount: number;
  total: number;
}

export const DEFAULT_JOB_CAPS: JobCaps = {
  perAccount: MAX_ACTIVE_JOBS_PER_ACCOUNT,
  total: MAX_ACTIVE_JOBS_TOTAL,
};

export function accountBusyError(perAccount: number): string {
  return `busy: you already have ${perAccount} running ${perAccount === 1 ? "job" : "jobs"}; wait for one to finish or cancel it`;
}

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
  /** Take a slot for `jobId`; false when `limit` slots are already taken. */
  async acquire(jobId: string, limit = MAX_ACTIVE_JOBS_PER_ACCOUNT): Promise<boolean> {
    const current = (await this.ctx.storage.get<JobSlots>(SLOTS_KEY)) ?? {};
    const { ok, slots } = takeSlot(current, jobId, Date.now(), limit);
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
  acquire(jobId: string, limit?: number): Promise<boolean>;
  release(jobId: string): Promise<void>;
}

export interface JobQuotaNamespace {
  getByName(name: string): AccountJobQuotaStub;
}

/** Why a job could not take its slots. */
export type AcquireResult = "ok" | "account-busy" | "server-busy";

/** What the Worker and the job Durable Object use: slots addressed by account. */
export interface JobQuota {
  /** Take the account slot, then the server slot; on failure nothing stays taken. */
  acquire(userId: string, jobId: string): Promise<AcquireResult>;
  /** Give back both slots of the job (idempotent). */
  release(userId: string, jobId: string): Promise<void>;
}

export function durableJobQuota(
  namespace: JobQuotaNamespace,
  caps: JobCaps = DEFAULT_JOB_CAPS,
): JobQuota {
  const server = () => namespace.getByName(SERVER_SLOTS_NAME);
  return {
    async acquire(userId, jobId) {
      const account = namespace.getByName(userId);
      if (!(await account.acquire(jobId, caps.perAccount))) return "account-busy";
      let taken = false;
      try {
        taken = await server().acquire(jobId, caps.total);
      } finally {
        // The server call may have saved its slot and then failed to answer
        // (e.g. the object restarted), so give back both; releasing is idempotent.
        if (!taken) await Promise.allSettled([account.release(jobId), server().release(jobId)]);
      }
      return taken ? "ok" : "server-busy";
    },
    async release(userId, jobId) {
      await Promise.all([namespace.getByName(userId).release(jobId), server().release(jobId)]);
    },
  };
}

/** The caller-facing message for a refused acquire. */
export function quotaError(result: Exclude<AcquireResult, "ok">, caps: JobCaps): string {
  return result === "account-busy" ? accountBusyError(caps.perAccount) : SERVER_AT_CAPACITY_ERROR;
}
