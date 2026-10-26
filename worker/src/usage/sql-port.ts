/**
 * The slice of Durable Object SQLite storage the usage ledger uses, so the
 * ledger runs unchanged on `ctx.storage.sql` in production and on an
 * in-memory SQLite database in tests. Calls are synchronous: a sequence of
 * them with no `await` in between cannot interleave with another request.
 */

export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;

export interface SqlPort {
  /** Run one statement; rows for a query, an empty list otherwise. */
  exec<T extends SqlRow = SqlRow>(query: string, ...params: SqlValue[]): T[];
  /** Run `fn` atomically: every write in it commits, or none does. */
  transaction<T>(fn: () => T): T;
}

/** Durable Object storage as a SqlPort. */
export function durableSqlPort(storage: DurableObjectStorage): SqlPort {
  return {
    exec: <T extends SqlRow>(query: string, ...params: SqlValue[]) =>
      storage.sql.exec<T>(query, ...params).toArray(),
    transaction: (fn) => storage.transactionSync(fn),
  };
}

/** SQL bind value: undefined becomes NULL, booleans 1/0, non-finite numbers NULL. */
export function v(value: string | number | boolean | null | undefined): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return value;
}
