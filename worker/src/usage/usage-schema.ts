/**
 * Ledger schema, applied in order on first use of an account's database.
 * Migrations are forward-only and additive (ADR 001): a Worker rolled back
 * to an older version still reads the tables it knows. `user_version`
 * records how many have run.
 */

import type { SqlPort } from "./sql-port.js";

const MIGRATIONS: readonly string[][] = [
  [
    `CREATE TABLE usage_events (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      source TEXT NOT NULL,
      client_id TEXT,
      project TEXT,
      trace_id TEXT NOT NULL,
      job_id TEXT,
      history_id TEXT,
      command TEXT NOT NULL,
      provider TEXT NOT NULL,
      model_requested TEXT,
      model_resolved TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      error_code TEXT,
      error_reason TEXT,
      started_at INTEGER NOT NULL,
      running_at INTEGER,
      finished_at INTEGER,
      duration_ms INTEGER,
      output_count INTEGER,
      output_bytes INTEGER,
      outputs_json TEXT,
      provider_ids_json TEXT,
      tokens_input INTEGER,
      tokens_output INTEGER,
      tokens_total INTEGER,
      tokens_thinking INTEGER,
      characters INTEGER,
      audio_seconds REAL,
      credits REAL,
      credits_unit TEXT,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      currency TEXT NOT NULL DEFAULT 'USD',
      rate_source TEXT,
      rate_version TEXT,
      rate_effective TEXT,
      provenance TEXT NOT NULL,
      charge_state TEXT NOT NULL,
      metrics_json TEXT,
      spans_json TEXT,
      http_requests INTEGER,
      http_errors INTEGER,
      http_ms INTEGER,
      settled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    "CREATE INDEX usage_events_started ON usage_events (started_at)",
    "CREATE INDEX usage_events_provider ON usage_events (provider, started_at)",
    "CREATE INDEX usage_events_model ON usage_events (model_resolved, started_at)",
    "CREATE INDEX usage_events_source ON usage_events (source, started_at)",
    "CREATE INDEX usage_events_project ON usage_events (project, started_at)",
    `CREATE TABLE adjustments (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      reason TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    "CREATE INDEX adjustments_event ON adjustments (event_id)",
    `CREATE TABLE budgets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_value TEXT,
      period TEXT NOT NULL,
      window_start INTEGER,
      window_end INTEGER,
      limit_usd REAL NOT NULL,
      mode TEXT NOT NULL,
      reserve_usd REAL,
      unknown_price TEXT NOT NULL,
      thresholds_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE TABLE budget_alerts (
      budget_id TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      threshold INTEGER NOT NULL,
      fired_at INTEGER NOT NULL,
      committed_usd REAL NOT NULL,
      PRIMARY KEY (budget_id, window_start, threshold)
    )`,
    `CREATE TABLE reservations (
      job_id TEXT PRIMARY KEY,
      amount_usd REAL NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    "CREATE INDEX reservations_state ON reservations (state)",
    `CREATE TABLE activities (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT,
      meta_json TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    )`,
    "CREATE INDEX activities_ts ON activities (ts)",
    "CREATE INDEX activities_kind ON activities (kind, ts)",
    `CREATE TABLE rate_card (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      unit TEXT NOT NULL,
      usd REAL NOT NULL,
      effective_from TEXT NOT NULL,
      version TEXT NOT NULL,
      PRIMARY KEY (provider, model, unit, effective_from)
    )`,
    `CREATE TABLE balances (
      provider TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      checked_at INTEGER NOT NULL,
      kind TEXT,
      unit TEXT,
      remaining REAL,
      used REAL,
      limit_value REAL,
      detail TEXT
    )`,
    `CREATE TABLE debug_logs (
      event_id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  ],
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Bring the database up to the latest schema; a no-op once it is there. */
export function migrate(sql: SqlPort): void {
  const current = Number(
    sql.exec<{ user_version: number }>("PRAGMA user_version")[0]?.user_version ?? 0,
  );
  if (current >= MIGRATIONS.length) return;
  sql.transaction(() => {
    for (let i = current; i < MIGRATIONS.length; i++) {
      for (const statement of MIGRATIONS[i] ?? []) sql.exec(statement);
    }
    sql.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
  });
}
