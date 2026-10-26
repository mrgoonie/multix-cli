/**
 * In-memory SQLite (node:sqlite) as a SqlPort, so the usage ledger runs in
 * tests with the same SQL it runs on Durable Object storage.
 */

import { DatabaseSync } from "node:sqlite";
import type { AccountUsageNamespace, AccountUsageStub } from "../src/usage/account-usage.js";
import type { SqlPort, SqlRow, SqlValue } from "../src/usage/sql-port.js";
import { UsageService } from "../src/usage/usage-service.js";

export function memorySql(): SqlPort & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  let depth = 0;
  return {
    db,
    exec<T extends SqlRow>(query: string, ...params: SqlValue[]): T[] {
      const statement = db.prepare(query);
      if (
        /^\s*(SELECT|WITH|PRAGMA user_version\s*$)/i.test(query) ||
        /\bRETURNING\b/i.test(query)
      ) {
        return statement.all(...params) as T[];
      }
      statement.run(...params);
      return [];
    },
    transaction<T>(fn: () => T): T {
      const name = `sp${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        depth--;
      }
    },
  };
}

/** A clock tests can move. */
export function testClock(start = Date.UTC(2026, 9, 26, 12)) {
  let t = start;
  return {
    now: () => t,
    set(value: number) {
      t = value;
    },
    advance(ms: number) {
      t += ms;
    },
  };
}

/** MULTIX_USAGE stand-in: one in-memory ledger per account name, called like RPC (async, cloned). */
export function memoryUsageNamespace(now: () => number = Date.now) {
  const services = new Map<string, UsageService>();
  const service = (name: string) => {
    let s = services.get(name);
    if (!s) {
      s = new UsageService(memorySql(), now);
      services.set(name, s);
    }
    return s;
  };
  const namespace: AccountUsageNamespace = {
    getByName(name: string): AccountUsageStub {
      return new Proxy({} as AccountUsageStub, {
        get(_t, method: string) {
          return async (...args: unknown[]) => {
            const s = service(name) as unknown as Record<string, (...a: unknown[]) => unknown>;
            const result = s[method]?.apply(s, structuredClone(args));
            return result === undefined ? undefined : structuredClone(result);
          };
        },
      });
    },
  };
  return { namespace, service };
}
