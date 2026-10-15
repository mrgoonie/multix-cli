/**
 * In-memory stand-ins for the Durable Object bindings (MULTIX_JOBS,
 * MULTIX_JOB_QUOTA and MULTIX_EVENTS) used by the OAuth and REST API tests.
 */

import type { AccountEventsNamespace, AccountEventsStub } from "../src/events/account-events.js";
import { EventHub } from "../src/events/event-hub.js";
import { AccountJobQuota, type JobQuotaNamespace } from "../src/jobs/account-job-quota.js";
import type { JobSpec, JobView } from "../src/jobs/job-protocol.js";
import type { JobContainerStub, JobNamespace } from "../src/jobs/job-store.js";
import { fakeDoStorage } from "./fake-do-storage.js";

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

/**
 * MULTIX_EVENTS stand-in: the real EventHub per account over in-memory
 * storage, with webhook deliveries captured instead of sent.
 */
export function fakeEventsNamespace(respond: () => Response = () => new Response("ok")) {
  const hubs = new Map<string, EventHub>();
  const sent: { account: string; url: string; body: string }[] = [];
  const namespace: AccountEventsNamespace = {
    getByName(name: string): AccountEventsStub {
      let hub = hubs.get(name);
      if (!hub) {
        hub = new EventHub({
          storage: fakeDoStorage().storage,
          now: () => Date.now(),
          fetch: async (url, init) => {
            sent.push({ account: name, url, body: String(init.body) });
            return respond();
          },
        });
        hubs.set(name, hub);
      }
      return hub;
    },
  };
  return { namespace, hubs, sent };
}
