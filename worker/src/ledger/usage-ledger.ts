/**
 * One account's usage ledger on SQLite (the AccountLedger Durable Object's
 * storage; node:sqlite in tests): operations, cost adjustments, budgets with
 * threshold alerts, and a hash-chained activity log. See
 * plans/261026-0502-294-finops-dashboard/adr-ledger-storage.md for why this
 * lives in a per-account Durable Object rather than D1 or KV.
 *
 * Every method is synchronous: a Durable Object runs one synchronous block at
 * a time, so a write and the budget check that follows it cannot interleave
 * with another call. Idempotency comes from the operation id (`job_<uuid>`,
 * `cli_<history id>`): the first terminal record of an operation wins and a
 * replay (outbox relay retry, re-import, repeated status poll) is reported as
 * a duplicate, never counted twice.
 */

import {
  type Activity,
  type ActivityInput,
  type Adjustment,
  type AdjustmentKind,
  type Budget,
  type BudgetInput,
  type BudgetPeriod,
  type BudgetStatus,
  type GroupBy,
  LEDGER_SCHEMA_VERSION,
  type Operation,
  type OperationFilter,
  type OperationInput,
  type UsageSummary,
  type UsageTotals,
} from "./ledger-types.js";
import { sha256HexSync } from "./sha256-sync.js";

export type SqlValue = string | number | null;

/** The slice of SQLite the ledger needs: Durable Object `ctx.storage.sql` or node:sqlite. */
export interface SqlPort {
  query<T = Record<string, SqlValue>>(sql: string, ...bindings: SqlValue[]): T[];
  transaction<T>(fn: () => T): T;
}

/** Operations, adjustments and activities older than this are pruned (export first to archive). */
export const LEDGER_RETENTION_DAYS = 400;
export const MAX_BUDGETS = 20;
export const MAX_PAGE_SIZE = 200;
export const MAX_EXPORT_ROWS = 10_000;
const DAY_MS = 86_400_000;
const GENESIS_HASH = "0".repeat(64);
const MAX_GROUPS = 50;

const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE operations (
      op_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      source TEXT NOT NULL,
      client_id TEXT,
      client_name TEXT,
      project_id TEXT,
      trace_id TEXT NOT NULL,
      job_id TEXT,
      history_id TEXT,
      command TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      task TEXT,
      status TEXT NOT NULL,
      error_code TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      duration_ms INTEGER,
      output_count INTEGER,
      output_bytes INTEGER,
      tokens_input INTEGER,
      tokens_output INTEGER,
      tokens_total INTEGER,
      tokens_thinking INTEGER,
      credits REAL,
      credits_unit TEXT,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      cost_provenance TEXT NOT NULL,
      rate_source TEXT,
      http_requests INTEGER,
      http_errors INTEGER,
      detail TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    "CREATE INDEX operations_started ON operations(started_at)",
    "CREATE INDEX operations_provider ON operations(provider, started_at)",
    "CREATE INDEX operations_model ON operations(model, started_at)",
    "CREATE INDEX operations_source ON operations(source, started_at)",
    "CREATE INDEX operations_project ON operations(project_id, started_at)",
    `CREATE TABLE adjustments (
      id TEXT PRIMARY KEY,
      op_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      note TEXT,
      actor TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    "CREATE INDEX adjustments_op ON adjustments(op_id)",
    `CREATE TABLE budgets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      scope_value TEXT,
      period TEXT NOT NULL,
      limit_usd REAL NOT NULL,
      thresholds TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE budget_alerts (
      budget_id TEXT NOT NULL,
      period_start INTEGER NOT NULL,
      threshold INTEGER NOT NULL,
      spent_usd REAL NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (budget_id, period_start, threshold)
    )`,
    `CREATE TABLE activities (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject TEXT,
      metadata TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    )`,
    "CREATE INDEX activities_ts ON activities(ts)",
  ],
];

const OPERATION_COLUMNS = [
  "op_id",
  "schema_version",
  "source",
  "client_id",
  "client_name",
  "project_id",
  "trace_id",
  "job_id",
  "history_id",
  "command",
  "provider",
  "model",
  "task",
  "status",
  "error_code",
  "started_at",
  "finished_at",
  "duration_ms",
  "output_count",
  "output_bytes",
  "tokens_input",
  "tokens_output",
  "tokens_total",
  "tokens_thinking",
  "credits",
  "credits_unit",
  "estimated_cost_usd",
  "actual_cost_usd",
  "cost_provenance",
  "rate_source",
  "http_requests",
  "http_errors",
  "detail",
  "updated_at",
] as const;

const GROUP_COLUMN: Record<GroupBy, string> = {
  provider: "provider",
  model: "model",
  source: "source",
  command: "command",
  status: "status",
  client: "client_id",
  project: "project_id",
};

const BUDGET_SCOPE_COLUMN: Record<string, string | undefined> = {
  account: undefined,
  provider: "provider",
  model: "model",
  command: "command",
  source: "source",
  client: "client_id",
  project: "project_id",
};

/** Cost of one operation when known: provider/billed amount first, else the estimate. */
const KNOWN_COST = "COALESCE(actual_cost_usd, estimated_cost_usd)";

type Row = Record<string, SqlValue>;

function num(value: SqlValue | undefined): number {
  return typeof value === "number" ? value : 0;
}

function numOrNull(value: SqlValue | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function randomId(prefix: string, now: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const rand = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${now.toString(36)}${rand}`;
}

/** Start of the period that contains `now` (UTC; weeks start on Monday). */
export function periodBounds(period: BudgetPeriod, now: number): { start: number; end: number } {
  const date = new Date(now);
  if (period === "day") {
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    return { start, end: start + DAY_MS };
  }
  if (period === "week") {
    const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const sinceMonday = (date.getUTCDay() + 6) % 7;
    const start = dayStart - sinceMonday * DAY_MS;
    return { start, end: start + 7 * DAY_MS };
  }
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  return { start, end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) };
}

function whereClause(filter: OperationFilter): { sql: string; binds: SqlValue[] } {
  const parts: string[] = [];
  const binds: SqlValue[] = [];
  const eq = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    parts.push(`${column} = ?`);
    binds.push(value);
  };
  if (filter.from !== undefined) {
    parts.push("started_at >= ?");
    binds.push(filter.from);
  }
  if (filter.to !== undefined) {
    parts.push("started_at < ?");
    binds.push(filter.to);
  }
  eq("provider", filter.provider);
  eq("model", filter.model);
  eq("source", filter.source);
  eq("status", filter.status);
  eq("command", filter.command);
  eq("client_id", filter.client_id);
  eq("project_id", filter.project_id);
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", binds };
}

function rowToOperation(row: Row): Operation {
  let detail = {};
  try {
    detail = JSON.parse(String(row.detail ?? "{}"));
  } catch {
    detail = {};
  }
  return { ...(row as unknown as Operation), currency: "USD", detail };
}

function rowToBudget(row: Row): Budget {
  return {
    id: String(row.id),
    name: String(row.name),
    scope_kind: row.scope_kind as Budget["scope_kind"],
    scope_value: (row.scope_value as string | null) ?? null,
    period: row.period as BudgetPeriod,
    limit_usd: num(row.limit_usd),
    thresholds: JSON.parse(String(row.thresholds)) as number[],
    created_at: num(row.created_at),
    updated_at: num(row.updated_at),
  };
}

function rowToActivity(row: Row): Activity {
  return {
    seq: num(row.seq),
    id: String(row.id),
    ts: num(row.ts),
    actor: String(row.actor),
    kind: String(row.kind),
    subject: (row.subject as string | null) ?? null,
    metadata: JSON.parse(String(row.metadata)),
    prev_hash: String(row.prev_hash),
    hash: String(row.hash),
  };
}

/** The bytes an activity's hash covers: the previous hash and the row's content. */
function activityHash(prev: string, a: Omit<Activity, "seq" | "hash" | "prev_hash">): string {
  return sha256HexSync(
    `${prev}\n${JSON.stringify([a.id, a.ts, a.actor, a.kind, a.subject, a.metadata])}`,
  );
}

/** Keep activity metadata small and flat: at most 12 keys, short strings. */
function safeMetadata(input: Record<string, unknown>): Activity["metadata"] {
  const out: Activity["metadata"] = {};
  for (const [key, value] of Object.entries(input).slice(0, 12)) {
    if (!/^[a-z0-9_]{1,40}$/.test(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, 200);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean" || value === null) out[key] = value;
  }
  return out;
}

export type RecordResult = "accepted" | "duplicate";

export interface OperationPage {
  operations: Operation[];
  next_cursor: string | null;
}

export class UsageLedger {
  constructor(
    private readonly sql: SqlPort,
    private readonly now: () => number = Date.now,
  ) {
    this.migrate();
  }

  /** Apply pending schema migrations (versioned in `ledger_meta`). */
  private migrate(): void {
    this.sql.query("CREATE TABLE IF NOT EXISTS ledger_meta (key TEXT PRIMARY KEY, value TEXT)");
    const row = this.sql.query<{ value: string }>(
      "SELECT value FROM ledger_meta WHERE key = 'schema_version'",
    )[0];
    const current = row ? Number(row.value) : 0;
    if (current >= MIGRATIONS.length) return;
    this.sql.transaction(() => {
      for (let version = current; version < MIGRATIONS.length; version++) {
        for (const statement of MIGRATIONS[version] ?? []) this.sql.query(statement);
      }
      this.sql.query(
        "INSERT OR REPLACE INTO ledger_meta (key, value) VALUES ('schema_version', ?)",
        String(MIGRATIONS.length),
      );
    });
  }

  schemaVersion(): number {
    const row = this.sql.query<{ value: string }>(
      "SELECT value FROM ledger_meta WHERE key = 'schema_version'",
    )[0];
    return row ? Number(row.value) : 0;
  }

  // ---- operations -------------------------------------------------------

  private insertOperation(input: OperationInput, orIgnore: boolean): void {
    const op: Record<string, SqlValue> = {
      ...(input as unknown as Record<string, SqlValue>),
      schema_version: LEDGER_SCHEMA_VERSION,
      detail: JSON.stringify(input.detail ?? {}),
      updated_at: this.now(),
    };
    const placeholders = OPERATION_COLUMNS.map(() => "?").join(", ");
    this.sql.query(
      `INSERT ${orIgnore ? "OR IGNORE " : "OR REPLACE "}INTO operations (${OPERATION_COLUMNS.join(", ")}) VALUES (${placeholders})`,
      ...OPERATION_COLUMNS.map((c) => op[c] ?? null),
    );
  }

  /** A job was handed to its container: record it as running (no-op when already known). */
  recordStart(input: OperationInput): RecordResult {
    return this.sql.transaction(() => {
      if (this.getOperation(input.op_id)) return "duplicate";
      this.insertOperation({ ...input, status: "running" }, true);
      return "accepted";
    });
  }

  /**
   * An operation reached its final state. The first final record wins; it
   * keeps who started the operation (source, client, project, start time)
   * from the running record when there is one. Crossed budget thresholds
   * are recorded as activities in the same transaction.
   */
  recordFinish(input: OperationInput): RecordResult {
    return this.sql.transaction(() => {
      const existing = this.getOperation(input.op_id);
      if (existing && existing.status !== "running") return "duplicate";
      const merged: OperationInput = existing
        ? {
            ...input,
            source: existing.source !== "unknown" ? existing.source : input.source,
            client_id: existing.client_id ?? input.client_id,
            client_name: existing.client_name ?? input.client_name,
            project_id: existing.project_id ?? input.project_id,
            started_at: Math.min(existing.started_at, input.started_at),
            model: input.model ?? existing.model,
            task: input.task ?? existing.task,
          }
        : input;
      this.insertOperation(merged, false);
      if (merged.source !== "cli") {
        this.appendActivity({
          actor: merged.client_name ?? merged.client_id ?? merged.source,
          kind: `job.${merged.status}`,
          subject: merged.op_id,
          metadata: { command: merged.command, provider: merged.provider, source: merged.source },
        });
      }
      this.evaluateBudgets();
      return "accepted";
    });
  }

  /** Import already-finished operations (CLI history); returns accepted / duplicate counts. */
  importOperations(
    inputs: OperationInput[],
    actor: string,
  ): { accepted: number; duplicates: number } {
    return this.sql.transaction(() => {
      let accepted = 0;
      let duplicates = 0;
      for (const input of inputs) {
        if (this.getOperation(input.op_id)) duplicates++;
        else {
          this.insertOperation(input, true);
          accepted++;
        }
      }
      if (accepted > 0 || duplicates > 0) {
        this.appendActivity({
          actor,
          kind: "usage.imported",
          subject: null,
          metadata: { accepted, duplicates },
        });
      }
      if (accepted > 0) this.evaluateBudgets();
      return { accepted, duplicates };
    });
  }

  getOperation(opId: string): Operation | null {
    const row = this.sql.query<Row>("SELECT * FROM operations WHERE op_id = ?", opId)[0];
    return row ? rowToOperation(row) : null;
  }

  /** Newest first; `cursor` is the `next_cursor` of the previous page. */
  listOperations(filter: OperationFilter, limit = 50, cursor?: string): OperationPage {
    const size = Math.max(1, Math.min(limit, MAX_PAGE_SIZE));
    const where = whereClause(filter);
    let sql = where.sql;
    const binds = [...where.binds];
    const after = cursor ? parseCursor(cursor) : undefined;
    if (after) {
      sql += `${sql ? " AND" : "WHERE"} (started_at < ? OR (started_at = ? AND op_id < ?))`;
      binds.push(after.startedAt, after.startedAt, after.opId);
    }
    const rows = this.sql.query<Row>(
      `SELECT * FROM operations ${sql} ORDER BY started_at DESC, op_id DESC LIMIT ?`,
      ...binds,
      size + 1,
    );
    const operations = rows.slice(0, size).map(rowToOperation);
    const last = operations[operations.length - 1];
    return {
      operations,
      next_cursor: rows.length > size && last ? `${last.started_at}~${last.op_id}` : null,
    };
  }

  /** Up to MAX_EXPORT_ROWS operations, oldest first, for CSV/JSON export. */
  exportOperations(filter: OperationFilter): { operations: Operation[]; truncated: boolean } {
    const where = whereClause(filter);
    const rows = this.sql.query<Row>(
      `SELECT * FROM operations ${where.sql} ORDER BY started_at ASC, op_id ASC LIMIT ?`,
      ...where.binds,
      MAX_EXPORT_ROWS + 1,
    );
    return {
      operations: rows.slice(0, MAX_EXPORT_ROWS).map(rowToOperation),
      truncated: rows.length > MAX_EXPORT_ROWS,
    };
  }

  // ---- adjustments ------------------------------------------------------

  addAdjustment(
    opId: string,
    kind: AdjustmentKind,
    amountUsd: number,
    note: string | null,
    actor: string,
  ): Adjustment | null {
    return this.sql.transaction(() => {
      if (!this.getOperation(opId)) return null;
      const now = this.now();
      const adjustment: Adjustment = {
        id: randomId("adj", now),
        op_id: opId,
        kind,
        amount_usd: round6(amountUsd),
        note,
        actor,
        created_at: now,
      };
      this.sql.query(
        "INSERT INTO adjustments (id, op_id, kind, amount_usd, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        adjustment.id,
        opId,
        kind,
        adjustment.amount_usd,
        note,
        actor,
        now,
      );
      this.appendActivity({
        actor,
        kind: "usage.adjusted",
        subject: opId,
        metadata: { adjustment: kind, amount_usd: adjustment.amount_usd },
      });
      this.evaluateBudgets();
      return adjustment;
    });
  }

  adjustmentsFor(opId: string): Adjustment[] {
    return this.sql.query<Adjustment>(
      "SELECT * FROM adjustments WHERE op_id = ? ORDER BY created_at ASC",
      opId,
    );
  }

  // ---- aggregates -------------------------------------------------------

  private totals(where: { sql: string; binds: SqlValue[] }): UsageTotals {
    const row =
      this.sql.query<Row>(
        `SELECT COUNT(*) AS operations,
          SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
          SUM(CASE WHEN status IN ('failed', 'timed_out', 'canceled') THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN actual_cost_usd IS NOT NULL THEN actual_cost_usd ELSE 0 END) AS reported,
          SUM(CASE WHEN actual_cost_usd IS NULL AND estimated_cost_usd IS NOT NULL THEN estimated_cost_usd ELSE 0 END) AS estimated,
          SUM(CASE WHEN ${KNOWN_COST} IS NULL THEN 1 ELSE 0 END) AS unknown_cost,
          SUM(credits) AS credits,
          SUM(tokens_input) AS tokens_input,
          SUM(tokens_output) AS tokens_output,
          SUM(COALESCE(output_count, 0)) AS output_count,
          SUM(COALESCE(output_bytes, 0)) AS output_bytes,
          SUM(CASE WHEN status = 'succeeded' THEN COALESCE(output_count, 0) ELSE 0 END) AS success_outputs,
          SUM(COALESCE(http_errors, 0)) AS http_errors
        FROM operations ${where.sql}`,
        ...where.binds,
      )[0] ?? {};
    const adjustments = num(
      this.sql.query<Row>(
        `SELECT SUM(a.amount_usd) AS total FROM adjustments a
          WHERE a.op_id IN (SELECT op_id FROM operations ${where.sql})`,
        ...where.binds,
      )[0]?.total,
    );
    const operations = num(row.operations);
    const succeeded = num(row.succeeded);
    const failed = num(row.failed);
    const reported = round6(num(row.reported));
    const estimated = round6(num(row.estimated));
    const known = round6(reported + estimated + adjustments);
    const unknown = num(row.unknown_cost);
    const successOutputs = num(row.success_outputs);
    const finished = succeeded + failed;
    return {
      operations,
      succeeded,
      failed,
      running: num(row.running),
      success_rate: finished > 0 ? round6(succeeded / finished) : null,
      provider_reported_cost_usd: reported,
      estimated_cost_usd: estimated,
      adjustments_usd: round6(adjustments),
      known_cost_usd: known,
      unknown_cost_operations: unknown,
      credits: numOrNull(row.credits),
      tokens_input: numOrNull(row.tokens_input),
      tokens_output: numOrNull(row.tokens_output),
      output_count: num(row.output_count),
      output_bytes: num(row.output_bytes),
      http_errors: num(row.http_errors),
      latency_p50_ms: this.percentile(where, 0.5),
      latency_p95_ms: this.percentile(where, 0.95),
      cost_per_successful_output_usd:
        unknown === 0 && successOutputs > 0 ? round6(known / successOutputs) : null,
    };
  }

  /** Nearest-rank percentile of finished operations' durations. */
  private percentile(where: { sql: string; binds: SqlValue[] }, p: number): number | null {
    const clause = `${where.sql ? `${where.sql} AND` : "WHERE"} duration_ms IS NOT NULL`;
    const count = num(
      this.sql.query<Row>(`SELECT COUNT(*) AS n FROM operations ${clause}`, ...where.binds)[0]?.n,
    );
    if (count === 0) return null;
    const offset = Math.max(0, Math.ceil(p * count) - 1);
    const row = this.sql.query<Row>(
      `SELECT duration_ms FROM operations ${clause} ORDER BY duration_ms ASC LIMIT 1 OFFSET ?`,
      ...where.binds,
      offset,
    )[0];
    return numOrNull(row?.duration_ms);
  }

  summary(
    filter: OperationFilter & { from: number; to: number },
    groupBy: GroupBy | null = null,
    tzOffsetMinutes = 0,
  ): UsageSummary {
    const where = whereClause(filter);
    const totals = this.totals(where);
    let groups: UsageSummary["groups"] = [];
    if (groupBy) {
      const column = GROUP_COLUMN[groupBy];
      const keys = this.sql.query<{ key: string | null }>(
        `SELECT ${column} AS key FROM operations ${where.sql}
          GROUP BY ${column} ORDER BY SUM(COALESCE(${KNOWN_COST}, 0)) DESC, COUNT(*) DESC LIMIT ?`,
        ...where.binds,
        MAX_GROUPS,
      );
      groups = keys.map(({ key }) => {
        const clause =
          key === null
            ? `${where.sql ? `${where.sql} AND` : "WHERE"} ${column} IS NULL`
            : `${where.sql ? `${where.sql} AND` : "WHERE"} ${column} = ?`;
        const binds = key === null ? where.binds : [...where.binds, key];
        return { key, ...this.totals({ sql: clause, binds }) };
      });
      // The SQL order ignores adjustments; order by the final known cost.
      groups.sort((a, b) => b.known_cost_usd - a.known_cost_usd || b.operations - a.operations);
    }
    const offsetMs = Math.trunc(tzOffsetMinutes) * 60_000;
    const seriesRows = this.sql.query<Row>(
      `SELECT CAST((started_at + ?) / ${DAY_MS} AS INTEGER) AS day,
          COUNT(*) AS operations,
          SUM(CASE WHEN status IN ('failed', 'timed_out', 'canceled') THEN 1 ELSE 0 END) AS failed,
          SUM(COALESCE(${KNOWN_COST}, 0)) AS known,
          SUM(CASE WHEN ${KNOWN_COST} IS NULL THEN 1 ELSE 0 END) AS unknown_cost
        FROM operations ${where.sql} GROUP BY day ORDER BY day ASC`,
      offsetMs,
      ...where.binds,
    );
    // Adjustments are dated by their operation's start.
    const adjustmentRows = this.sql.query<Row>(
      `SELECT CAST((o.started_at + ?) / ${DAY_MS} AS INTEGER) AS day, SUM(a.amount_usd) AS total
        FROM adjustments a JOIN operations o ON o.op_id = a.op_id
        WHERE o.op_id IN (SELECT op_id FROM operations ${where.sql}) GROUP BY day`,
      offsetMs,
      ...where.binds,
    );
    const adjustByDay = new Map(adjustmentRows.map((r) => [num(r.day), num(r.total)]));
    return {
      from: filter.from,
      to: filter.to,
      tz_offset_minutes: Math.trunc(tzOffsetMinutes),
      totals,
      group_by: groupBy,
      groups,
      series: seriesRows.map((r) => ({
        bucket_start: num(r.day) * DAY_MS - offsetMs,
        operations: num(r.operations),
        failed: num(r.failed),
        known_cost_usd: round6(num(r.known) + (adjustByDay.get(num(r.day)) ?? 0)),
        unknown_cost_operations: num(r.unknown_cost),
      })),
    };
  }

  // ---- budgets ----------------------------------------------------------

  listBudgets(): Budget[] {
    return this.sql
      .query<Row>("SELECT * FROM budgets ORDER BY created_at ASC, id ASC")
      .map(rowToBudget);
  }

  getBudget(id: string): Budget | null {
    const row = this.sql.query<Row>("SELECT * FROM budgets WHERE id = ?", id)[0];
    return row ? rowToBudget(row) : null;
  }

  /** Null when the account already has MAX_BUDGETS budgets. */
  createBudget(input: BudgetInput, actor: string): Budget | null {
    return this.sql.transaction(() => {
      const count = num(this.sql.query<Row>("SELECT COUNT(*) AS n FROM budgets")[0]?.n);
      if (count >= MAX_BUDGETS) return null;
      const now = this.now();
      const budget: Budget = {
        ...input,
        id: randomId("bud", now),
        created_at: now,
        updated_at: now,
      };
      this.writeBudget(budget);
      this.appendActivity({
        actor,
        kind: "budget.created",
        subject: budget.id,
        metadata: this.budgetMetadata(budget),
      });
      this.evaluateBudgets();
      return budget;
    });
  }

  updateBudget(id: string, input: BudgetInput, actor: string): Budget | null {
    return this.sql.transaction(() => {
      const existing = this.getBudget(id);
      if (!existing) return null;
      const budget: Budget = { ...existing, ...input, id, updated_at: this.now() };
      this.writeBudget(budget);
      this.appendActivity({
        actor,
        kind: "budget.updated",
        subject: id,
        metadata: this.budgetMetadata(budget),
      });
      this.evaluateBudgets();
      return budget;
    });
  }

  deleteBudget(id: string, actor: string): boolean {
    return this.sql.transaction(() => {
      const existing = this.getBudget(id);
      if (!existing) return false;
      this.sql.query("DELETE FROM budgets WHERE id = ?", id);
      this.sql.query("DELETE FROM budget_alerts WHERE budget_id = ?", id);
      this.appendActivity({
        actor,
        kind: "budget.deleted",
        subject: id,
        metadata: { name: existing.name },
      });
      return true;
    });
  }

  private budgetMetadata(budget: Budget): Record<string, string | number> {
    return {
      name: budget.name,
      scope: budget.scope_value ? `${budget.scope_kind}:${budget.scope_value}` : budget.scope_kind,
      period: budget.period,
      limit_usd: budget.limit_usd,
    };
  }

  private writeBudget(budget: Budget): void {
    this.sql.query(
      `INSERT OR REPLACE INTO budgets (id, name, scope_kind, scope_value, period, limit_usd, thresholds, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      budget.id,
      budget.name,
      budget.scope_kind,
      budget.scope_value,
      budget.period,
      budget.limit_usd,
      JSON.stringify(budget.thresholds),
      budget.created_at,
      budget.updated_at,
    );
  }

  budgetStatus(budget: Budget, now = this.now()): BudgetStatus {
    const { start, end } = periodBounds(budget.period, now);
    const column = BUDGET_SCOPE_COLUMN[budget.scope_kind];
    const scope = column ? `AND ${column} = ?` : "";
    const binds: SqlValue[] = column ? [start, end, budget.scope_value] : [start, end];
    const row =
      this.sql.query<Row>(
        `SELECT SUM(COALESCE(${KNOWN_COST}, 0)) AS known,
            SUM(CASE WHEN ${KNOWN_COST} IS NULL AND status != 'running' THEN 1 ELSE 0 END) AS unknown_cost
          FROM operations WHERE started_at >= ? AND started_at < ? ${scope}`,
        ...binds,
      )[0] ?? {};
    const adjustments = num(
      this.sql.query<Row>(
        `SELECT SUM(amount_usd) AS total FROM adjustments WHERE op_id IN
          (SELECT op_id FROM operations WHERE started_at >= ? AND started_at < ? ${scope})`,
        ...binds,
      )[0]?.total,
    );
    const spent = round6(num(row.known) + adjustments);
    const percent = budget.limit_usd > 0 ? round6((spent / budget.limit_usd) * 100) : 0;
    const elapsed = Math.max(0, Math.min(now, end) - start);
    // Too early in the period to project anything meaningful.
    const forecast =
      elapsed >= (end - start) / 48 ? round6((spent / elapsed) * (end - start)) : null;
    const alerts = this.sql
      .query<Row>(
        "SELECT threshold FROM budget_alerts WHERE budget_id = ? AND period_start = ? ORDER BY threshold",
        budget.id,
        start,
      )
      .map((r) => num(r.threshold));
    const lowest = Math.min(...budget.thresholds, 100);
    return {
      ...budget,
      period_start: start,
      period_end: end,
      spent_usd: spent,
      unknown_cost_operations: num(row.unknown_cost),
      percent,
      forecast_usd: forecast,
      state: percent >= 100 ? "exceeded" : percent >= lowest ? "warning" : "ok",
      alerts,
    };
  }

  budgetStatuses(): BudgetStatus[] {
    const now = this.now();
    return this.listBudgets().map((b) => this.budgetStatus(b, now));
  }

  /** Record each threshold a budget crossed for the first time this period. */
  private evaluateBudgets(): void {
    const now = this.now();
    for (const budget of this.listBudgets()) {
      const status = this.budgetStatus(budget, now);
      for (const threshold of budget.thresholds) {
        if (status.percent < threshold || status.alerts.includes(threshold)) continue;
        this.sql.query(
          "INSERT OR IGNORE INTO budget_alerts (budget_id, period_start, threshold, spent_usd, created_at) VALUES (?, ?, ?, ?, ?)",
          budget.id,
          status.period_start,
          threshold,
          status.spent_usd,
          now,
        );
        this.appendActivity({
          actor: "system",
          kind: "budget.threshold_crossed",
          subject: budget.id,
          metadata: {
            name: budget.name,
            threshold,
            spent_usd: status.spent_usd,
            limit_usd: budget.limit_usd,
            unknown_cost_operations: status.unknown_cost_operations,
          },
        });
      }
    }
  }

  // ---- activities -------------------------------------------------------

  /** Append one activity to the hash chain. */
  appendActivity(input: ActivityInput): Activity {
    return this.sql.transaction(() => {
      const ts = input.ts ?? this.now();
      const prev =
        this.sql.query<{ hash: string }>("SELECT hash FROM activities ORDER BY seq DESC LIMIT 1")[0]
          ?.hash ?? GENESIS_HASH;
      const base = {
        id: randomId("act", ts),
        ts,
        actor: input.actor.slice(0, 200),
        kind: input.kind.slice(0, 64),
        subject: input.subject ? input.subject.slice(0, 200) : null,
        metadata: safeMetadata(input.metadata),
      };
      const hash = activityHash(prev, base);
      this.sql.query(
        "INSERT INTO activities (id, ts, actor, kind, subject, metadata, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        base.id,
        ts,
        base.actor,
        base.kind,
        base.subject,
        JSON.stringify(base.metadata),
        prev,
        hash,
      );
      const seq = num(
        this.sql.query<Row>("SELECT seq FROM activities WHERE id = ?", base.id)[0]?.seq,
      );
      return { ...base, seq, prev_hash: prev, hash };
    });
  }

  /** Newest first; `kind` matches a prefix (e.g. "budget." or "job."). */
  listActivities(
    options: { from?: number; to?: number; kind?: string; q?: string; before?: number },
    limit = 50,
  ): { activities: Activity[]; next_cursor: string | null } {
    const size = Math.max(1, Math.min(limit, MAX_PAGE_SIZE));
    const parts: string[] = [];
    const binds: SqlValue[] = [];
    if (options.from !== undefined) {
      parts.push("ts >= ?");
      binds.push(options.from);
    }
    if (options.to !== undefined) {
      parts.push("ts < ?");
      binds.push(options.to);
    }
    if (options.kind) {
      parts.push("substr(kind, 1, ?) = ?");
      binds.push(options.kind.length, options.kind);
    }
    if (options.q) {
      parts.push(
        "(instr(lower(kind), ?) > 0 OR instr(lower(COALESCE(subject, '')), ?) > 0 OR instr(lower(actor), ?) > 0 OR instr(lower(metadata), ?) > 0)",
      );
      const q = options.q.toLowerCase();
      binds.push(q, q, q, q);
    }
    if (options.before !== undefined) {
      parts.push("seq < ?");
      binds.push(options.before);
    }
    const rows = this.sql.query<Row>(
      `SELECT * FROM activities ${parts.length ? `WHERE ${parts.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`,
      ...binds,
      size + 1,
    );
    const activities = rows.slice(0, size).map(rowToActivity);
    const last = activities[activities.length - 1];
    return { activities, next_cursor: rows.length > size && last ? String(last.seq) : null };
  }

  /**
   * Recompute the hash chain. Pruning removes the oldest rows, so the check
   * starts from the oldest remaining row's stored predecessor hash.
   */
  verifyActivities(): { ok: boolean; checked: number; first_bad_seq: number | null } {
    let checked = 0;
    let prev: string | undefined;
    let afterSeq = 0;
    for (;;) {
      const rows = this.sql
        .query<Row>("SELECT * FROM activities WHERE seq > ? ORDER BY seq ASC LIMIT 500", afterSeq)
        .map(rowToActivity);
      if (rows.length === 0) break;
      for (const row of rows) {
        const expectedPrev = prev ?? row.prev_hash;
        if (row.prev_hash !== expectedPrev || activityHash(expectedPrev, row) !== row.hash) {
          return { ok: false, checked, first_bad_seq: row.seq };
        }
        prev = row.hash;
        afterSeq = row.seq;
        checked++;
      }
    }
    return { ok: true, checked, first_bad_seq: null };
  }

  // ---- lifecycle --------------------------------------------------------

  /** Drop data older than the retention period; returns the rows removed per table. */
  prune(retentionDays = LEDGER_RETENTION_DAYS): Record<string, number> {
    const cutoff = this.now() - retentionDays * DAY_MS;
    return this.sql.transaction(() => {
      const count = (sql: string) => num(this.sql.query<Row>(sql, cutoff)[0]?.n);
      const removed = {
        operations: count("SELECT COUNT(*) AS n FROM operations WHERE started_at < ?"),
        activities: count("SELECT COUNT(*) AS n FROM activities WHERE ts < ?"),
      };
      this.sql.query(
        "DELETE FROM adjustments WHERE op_id IN (SELECT op_id FROM operations WHERE started_at < ?)",
        cutoff,
      );
      this.sql.query("DELETE FROM operations WHERE started_at < ?", cutoff);
      this.sql.query("DELETE FROM activities WHERE ts < ?", cutoff);
      this.sql.query("DELETE FROM budget_alerts WHERE period_start < ?", cutoff);
      return removed;
    });
  }

  /** Delete every ledger row of the account (privacy request); the action itself stays logged. */
  deleteAllData(actor: string): void {
    this.sql.transaction(() => {
      for (const table of ["operations", "adjustments", "budget_alerts", "activities"]) {
        this.sql.query(`DELETE FROM ${table}`);
      }
      this.appendActivity({ actor, kind: "ledger.deleted", subject: null, metadata: {} });
    });
  }

  storageStats(): { operations: number; activities: number; budgets: number } {
    const n = (table: string) =>
      num(this.sql.query<Row>(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n);
    return { operations: n("operations"), activities: n("activities"), budgets: n("budgets") };
  }
}

function parseCursor(cursor: string): { startedAt: number; opId: string } | undefined {
  const match = /^(\d{1,16})~([A-Za-z0-9_-]{1,160})$/.exec(cursor);
  if (!match?.[1] || !match[2]) return undefined;
  return { startedAt: Number(match[1]), opId: match[2] };
}
