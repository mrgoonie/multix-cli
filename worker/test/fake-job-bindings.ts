/**
 * In-memory stand-ins for the job Durable Object bindings (MULTIX_JOBS and
 * MULTIX_JOB_QUOTA) used by the OAuth and REST API tests.
 */

import { AccountJobQuota, type JobQuotaNamespace } from "../src/jobs/account-job-quota.js";
import type { JobSpec, JobView } from "../src/jobs/job-protocol.js";
import type { JobContainerStub, JobNamespace } from "../src/jobs/job-store.js";

/** MULTIX_JOBS stand-in: one stub per job name, finishing as soon as it starts. */
export function fakeNamespace() {
  const specs = new Map<string, JobSpec>();
  const namespace: JobNamespace = {
    getByName(name: string): JobContainerStub {
      const done = (): JobView => ({
        status: "succeeded",
        createdAt: 1,
        finishedAt: 2,
        result: {
          status: "succeeded",
          exitCode: 0,
          stdout: `key=${specs.get(name)?.env.GEMINI_API_KEY}`,
          stderrTail: "",
          outputs: [],
        },
      });
      return {
        startJob: async (spec) => {
          specs.set(name, spec);
          return done();
        },
        jobStatus: async () => (specs.has(name) ? done() : null),
        cancelJob: async () => null,
      };
    },
  };
  return { namespace, specs };
}

/** MULTIX_JOB_QUOTA stand-in: the real AccountJobQuota class over in-memory storage. */
export function fakeQuotaNamespace(): JobQuotaNamespace {
  const objects = new Map<string, AccountJobQuota>();
  return {
    getByName(name: string) {
      let quota = objects.get(name);
      if (!quota) {
        const data = new Map<string, unknown>();
        const storage = {
          get: async (key: string) => structuredClone(data.get(key)),
          put: async (key: string, value: unknown) => void data.set(key, structuredClone(value)),
        };
        quota = new AccountJobQuota({ storage } as never, {} as never);
        objects.set(name, quota);
      }
      return quota;
    },
  };
}
