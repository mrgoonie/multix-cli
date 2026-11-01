/**
 * The standalone server's one SQLite file (node:sqlite, WAL mode). It holds
 * what Cloudflare keeps in KV and Durable Object storage:
 *
 * - `kv`: the OAUTH_KV and ACCOUNTS_KV namespaces (ns = binding name).
 * - `do_storage` / `do_alarm`: the storage and alarm of each Durable Object
 *   instance (ns = binding name, id = the name passed to `getByName`).
 *
 * The file must live on a persistent volume (MULTIX_DATA_DIR). One process
 * owns it: the standalone server is single-replica.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  ns TEXT NOT NULL,
  key TEXT NOT NULL,
  value BLOB NOT NULL,
  expires_at INTEGER,
  metadata TEXT,
  PRIMARY KEY (ns, key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS kv_expiry ON kv (expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS do_storage (
  ns TEXT NOT NULL,
  id TEXT NOT NULL,
  key TEXT NOT NULL,
  value BLOB NOT NULL,
  PRIMARY KEY (ns, id, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS do_alarm (
  ns TEXT NOT NULL,
  id TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  PRIMARY KEY (ns, id)
) WITHOUT ROWID;
`;

export interface MultixDatabase {
  db: DatabaseSync;
  /** Run `fn` in one transaction (BEGIN IMMEDIATE … COMMIT, ROLLBACK on throw). */
  transaction<T>(fn: () => T): T;
  /** A write and a read on the file, for readiness probes. */
  check(): void;
  close(): void;
}

export function openDatabase(path: string): MultixDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
  );
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `Database schema version ${version} is newer than this server (${SCHEMA_VERSION}); refusing to start`,
    );
  }
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  db.exec("CREATE TABLE IF NOT EXISTS health (id INTEGER PRIMARY KEY, at INTEGER NOT NULL)");
  const touch = db.prepare(
    "INSERT INTO health (id, at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at",
  );
  const read = db.prepare("SELECT at FROM health WHERE id = 1");
  let depth = 0;
  return {
    db,
    transaction<T>(fn: () => T): T {
      // Nested calls join the outer transaction.
      if (depth > 0) return fn();
      db.exec("BEGIN IMMEDIATE");
      depth++;
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
    check() {
      const now = Date.now();
      touch.run(now);
      if (Number((read.get() as { at: number } | undefined)?.at) !== now) {
        throw new Error("storage read-back mismatch");
      }
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}
