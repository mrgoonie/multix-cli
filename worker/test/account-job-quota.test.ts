import { describe, expect, it } from "vitest";
import { jobCapsFrom } from "../src/config.js";
import {
  AccountJobQuota,
  type JobQuotaNamespace,
  MAX_ACTIVE_JOBS_PER_ACCOUNT,
  SERVER_SLOTS_NAME,
  durableJobQuota,
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

describe("durableJobQuota", () => {
  function namespace() {
    const objects = new Map<string, AccountJobQuota>();
    const ns: JobQuotaNamespace = {
      getByName(name) {
        let quota = objects.get(name);
        if (!quota) {
          quota = new AccountJobQuota(fakeState() as never, {} as never);
          objects.set(name, quota);
        }
        return quota;
      },
    };
    return ns;
  }

  it("takes an account slot and a server slot, and rolls back the account slot when the server is full", async () => {
    const ns = namespace();
    const quota = durableJobQuota(ns, { perAccount: 2, total: 2 });
    expect(await quota.acquire("gh-1", "a")).toBe("ok");
    expect(await quota.acquire("gh-2", "b")).toBe("ok");
    expect(await quota.acquire("gh-1", "c")).toBe("server-busy");
    // gh-1 still holds only "a": the refused job left no account slot behind.
    expect(await ns.getByName("gh-1").acquire("probe", 2)).toBe(true);
    await quota.release("gh-2", "b");
    expect(await quota.acquire("gh-1", "c")).toBe("account-busy");
    expect(await quota.acquire("gh-3", "d")).toBe("ok");
    expect(SERVER_SLOTS_NAME.startsWith("gh-")).toBe(false);
  });

  it("frees both slots when the server call saves its slot and then fails", async () => {
    const ns = namespace();
    const real = ns.getByName(SERVER_SLOTS_NAME);
    const flaky: JobQuotaNamespace = {
      getByName(name) {
        if (name !== SERVER_SLOTS_NAME) return ns.getByName(name);
        return {
          acquire: async (jobId: string, limit?: number) => {
            await real.acquire(jobId, limit);
            throw new Error("object restarted");
          },
          release: (jobId: string) => real.release(jobId),
        } as never;
      },
    };
    await expect(
      durableJobQuota(flaky, { perAccount: 1, total: 1 }).acquire("gh-1", "a"),
    ).rejects.toThrow();
    const quota = durableJobQuota(ns, { perAccount: 1, total: 1 });
    expect(await quota.acquire("gh-1", "b")).toBe("ok");
  });
});

describe("jobCapsFrom", () => {
  it("reads the Worker vars with defaults and ceilings", () => {
    expect(jobCapsFrom({} as never)).toEqual({ perAccount: 2, total: 10 });
    expect(
      jobCapsFrom({ MULTIX_MAX_JOBS_PER_ACCOUNT: "3", MULTIX_MAX_JOBS_TOTAL: "25" } as never),
    ).toEqual({ perAccount: 3, total: 25 });
    expect(
      jobCapsFrom({ MULTIX_MAX_JOBS_PER_ACCOUNT: "0", MULTIX_MAX_JOBS_TOTAL: "abc" } as never),
    ).toEqual({ perAccount: 2, total: 10 });
    expect(
      jobCapsFrom({ MULTIX_MAX_JOBS_PER_ACCOUNT: "999", MULTIX_MAX_JOBS_TOTAL: "99999" } as never),
    ).toEqual({ perAccount: 50, total: 1000 });
  });
});
