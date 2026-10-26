/**
 * In-memory stand-ins for the Durable Object bindings (MULTIX_JOBS,
 * MULTIX_JOB_QUOTA, MULTIX_EVENTS and MULTIX_LEDGER) used by the OAuth and REST API tests.
 */

import type { AccountEventsNamespace, AccountEventsStub } from "../src/events/account-events.js";
import { EventHub } from "../src/events/event-hub.js";
import { AccountJobQuota, type JobQuotaNamespace } from "../src/jobs/account-job-quota.js";
import type { JobSpec, JobView } from "../src/jobs/job-protocol.js";
import type { JobContainerStub, JobNamespace } from "../src/jobs/job-store.js";
import type { AccountLedgerNamespace, AccountLedgerStub } from "../src/ledger/account-ledger.js";
import { jobFinishRecord } from "../src/ledger/ledger-records.js";
import { fakeDoStorage } from "./fake-do-storage.js";

/**
 * MULTIX_JOBS stand-in: one stub per job name, finishing as soon as it starts.
 * With `ledger`, the finished job's record is handed over the way the job
 * Durable Object's outbox relay does.
 */
export function fakeNamespace(ledger?: AccountLedgerNamespace) {
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
        startJob: async (spec, userId, _command, meta) => {
          specs.set(name, spec);
          if (ledger && meta) {
            await ledger.getByName(userId).recordFinish(jobFinishRecord(name, meta, done(), 2));
          }
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
          checkCallback: async () => undefined,
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

/**
 * MULTIX_LEDGER stand-in: the real AccountLedger class per account over an
 * in-memory node:sqlite database (async, like RPC).
 */
export async function fakeLedgerNamespace() {
  const { AccountLedger } = await import("../src/ledger/account-ledger.js");
  const { openSqlite } = await import("./sqlite-sql-port.js");
  const objects = new Map<string, InstanceType<typeof AccountLedger>>();
  const open = openSqlite;
  const namespace: AccountLedgerNamespace = {
    getByName(name: string): AccountLedgerStub {
      return new Proxy({} as AccountLedgerStub, {
        get:
          (_target, method: string) =>
          async (...args: unknown[]) => {
            let ledger = objects.get(name);
            if (!ledger) {
              const db = await open();
              let alarm: number | null = null;
              const storage = {
                sql: {
                  exec: (query: string, ...bindings: (string | number | null)[]) => {
                    const statement = db.prepare(query);
                    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) {
                      const rows = statement.all(...bindings);
                      return { toArray: () => rows };
                    }
                    statement.run(...bindings);
                    return { toArray: () => [] };
                  },
                },
                transactionSync: <T>(fn: () => T): T => {
                  db.exec("BEGIN");
                  try {
                    const result = fn();
                    db.exec("COMMIT");
                    return result;
                  } catch (error) {
                    db.exec("ROLLBACK");
                    throw error;
                  }
                },
                getAlarm: async () => alarm,
                setAlarm: async (time: number) => {
                  alarm = time;
                },
              };
              const ctx = {
                storage,
                blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
              };
              ledger = new AccountLedger(ctx as never, {});
              objects.set(name, ledger);
            }
            const fn = (ledger as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
            if (typeof fn !== "function") throw new Error(`no RPC method ${method}`);
            // RPC copies arguments and results.
            return structuredClone(await fn.apply(ledger, structuredClone(args)));
          },
      });
    },
  };
  return { namespace, objects };
}
