import { describe, expect, it } from "vitest";
import {
  AccountJobQuota,
  MAX_ACTIVE_JOBS_PER_ACCOUNT,
  takeSlot,
} from "../src/jobs/account-job-quota.js";
import { JOB_GIVE_UP_MS, JOB_SLOT_LEASE_MS } from "../src/jobs/job-protocol.js";

/** Minimal Durable Object storage: get/put of structured-cloned values. */
function fakeState() {
  const data = new Map<string, unknown>();
  return {
    storage: {
      get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
      put: async (key: string, value: unknown) => {
        data.set(key, structuredClone(value));
      },
    },
  };
}

describe("takeSlot", () => {
  it("allows two jobs per account and refuses a third", () => {
    expect(MAX_ACTIVE_JOBS_PER_ACCOUNT).toBe(2);
    let slots = {};
    for (const id of ["a", "b"]) {
      const taken = takeSlot(slots, id, 0);
      expect(taken.ok).toBe(true);
      slots = taken.slots;
    }
    expect(takeSlot(slots, "c", 0).ok).toBe(false);
    // Taking the same job again is not a second slot.
    expect(takeSlot(slots, "a", 0)).toMatchObject({ ok: true, slots });
  });

  it("frees a slot whose lease expired, and the lease outlives the job's own give-up time", () => {
    expect(JOB_SLOT_LEASE_MS).toBeGreaterThan(JOB_GIVE_UP_MS);
    const slots = { a: JOB_SLOT_LEASE_MS, b: 2 * JOB_SLOT_LEASE_MS };
    expect(takeSlot(slots, "c", JOB_SLOT_LEASE_MS - 1).ok).toBe(false);
    const later = takeSlot(slots, "c", JOB_SLOT_LEASE_MS);
    expect(later.ok).toBe(true);
    expect(Object.keys(later.slots).sort()).toEqual(["b", "c"]);
  });
});

describe("AccountJobQuota", () => {
  it("counts slots in storage and gives them back on release", async () => {
    const quota = new AccountJobQuota(fakeState() as never, {} as never);
    expect(await quota.acquire("job-1")).toBe(true);
    expect(await quota.acquire("job-2")).toBe(true);
    expect(await quota.acquire("job-3")).toBe(false);
    await quota.release("job-1");
    await quota.release("job-1"); // idempotent
    expect(await quota.acquire("job-3")).toBe(true);
    expect(await quota.acquire("job-4")).toBe(false);
  });
});
