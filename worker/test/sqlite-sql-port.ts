/**
 * SqlPort over node:sqlite for ledger tests, with the semantics the Durable
 * Object port has: queries return plain rows and a transaction that throws
 * rolls back (nested calls join the outer transaction).
 */

import type { SqlPort, SqlValue } from "../src/ledger/usage-ledger.js";

/** The slice of node:sqlite used here (the Worker typecheck has no Node types). */
export interface SqliteDatabase {
  prepare(sql: string): {
    all(...bindings: SqlValue[]): unknown[];
    run(...bindings: SqlValue[]): unknown;
  };
  exec(sql: string): void;
}

const sqliteModule = "node:sqlite";

export async function openSqlite(): Promise<SqliteDatabase> {
  const { DatabaseSync } = (await import(/* @vite-ignore */ sqliteModule)) as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  return new DatabaseSync(":memory:");
}

export function sqliteSqlPort(db: SqliteDatabase): SqlPort & { db: SqliteDatabase } {
  let depth = 0;
  return {
    db,
    query: <T>(sql: string, ...bindings: SqlValue[]) => {
      const statement = db.prepare(sql);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) return statement.all(...bindings) as T[];
      statement.run(...bindings);
      return [] as T[];
    },
    transaction: <T>(fn: () => T): T => {
      if (depth > 0) return fn();
      depth++;
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        depth--;
      }
    },
  };
}
