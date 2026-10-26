/**
 * Budgets over the usage ledger. A budget sums what runs in its scope and
 * window cost (provider-reported, billed and estimated USD, adjustments
 * included) plus what is held for runs still in flight or whose charge is
 * uncertain, and compares that with its limit.
 *
 * A `block` budget is checked before a Multix job starts: the job's price
 * (rate card `job` unit, else the budget's per-job reserve) is held, and the
 * job is refused when it would take the committed total over the limit. The
 * check and the hold run in one synchronous transaction, so two concurrent
 * jobs cannot both take the last dollars. Nothing here can stop spend made
 * outside Multix.
 */

import type { ActivityLog } from "./activity-log.js";
import { type SqlPort, type SqlRow, type SqlValue, v } from "./sql-port.js";
import {
  BUDGET_PERIODS,
  BUDGET_SCOPES,
  type Budget,
  type BudgetInput,
  type BudgetMode,
  type BudgetPeriod,
  type BudgetScope,
  type BudgetStatus,
  type UnknownPricePolicy,
} from "./usage-types.js";

export const MAX_BUDGETS = 50;
const DEFAULT_THRESHOLDS = [50, 80, 100];
const SCOPE_VALUE_RE = /^[A-Za-z0-9._:/ -]{1,128}$/;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export class BudgetError extends Error {}

interface BudgetRow extends SqlRow {
  id: string;
  name: string;
  scope: string;
  scope_value: string | null;
  period: string;
  window_start: number | null;
  window_end: number | null;
  limit_usd: number;
  mode: string;
  reserve_usd: number | null;
  unknown_price: string;
  thresholds_json: string;
  created_at: number;
  updated_at: number;
}

function toBudget(row: BudgetRow): Budget {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope as BudgetScope,
    scopeValue: row.scope_value,
    period: row.period as BudgetPeriod,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    limitUsd: row.limit_usd,
    mode: row.mode as BudgetMode,
    reserveUsd: row.reserve_usd,
    unknownPrice: row.unknown_price as UnknownPricePolicy,
    thresholds: JSON.parse(row.thresholds_json) as number[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function finiteIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** Validate a budget; throws BudgetError with a caller-safe message. */
export function parseBudgetInput(input: unknown): BudgetInput {
  const raw = (input ?? {}) as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length < 1 || name.length > 80) throw new BudgetError("name must be 1 to 80 characters");
  if (!BUDGET_SCOPES.includes(raw.scope as BudgetScope)) {
    throw new BudgetError(`scope must be one of ${BUDGET_SCOPES.join(", ")}`);
  }
  const scope = raw.scope as BudgetScope;
  let scopeValue: string | undefined;
  if (scope !== "account") {
    const value = raw.scopeValue ?? raw.scope_value;
    if (typeof value !== "string" || !SCOPE_VALUE_RE.test(value)) {
      throw new BudgetError(`scopeValue is required for a ${scope} budget`);
    }
    scopeValue = value;
  }
  if (!BUDGET_PERIODS.includes(raw.period as BudgetPeriod)) {
    throw new BudgetError(`period must be one of ${BUDGET_PERIODS.join(", ")}`);
  }
  const period = raw.period as BudgetPeriod;
  let windowStart: number | undefined;
  let windowEnd: number | undefined;
  if (period === "custom") {
    const start = raw.windowStart ?? raw.window_start;
    const end = raw.windowEnd ?? raw.window_end;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      (start as number) >= (end as number)
    ) {
      throw new BudgetError("a custom budget needs windowStart before windowEnd (epoch ms)");
    }
    windowStart = start as number;
    windowEnd = end as number;
  }
  const limitUsd = raw.limitUsd ?? raw.limit_usd;
  if (!finiteIn(limitUsd, 0.01, 1_000_000)) {
    throw new BudgetError("limitUsd must be a number from 0.01 to 1000000");
  }
  const mode = raw.mode ?? "alert";
  if (mode !== "alert" && mode !== "block") throw new BudgetError("mode must be alert or block");
  const reserve = raw.reserveUsd ?? raw.reserve_usd;
  if (reserve !== undefined && reserve !== null && !finiteIn(reserve, 0, 10_000)) {
    throw new BudgetError("reserveUsd must be a number from 0 to 10000");
  }
  const unknownPrice = raw.unknownPrice ?? raw.unknown_price ?? "allow";
  if (unknownPrice !== "allow" && unknownPrice !== "block") {
    throw new BudgetError("unknownPrice must be allow or block");
  }
  const thresholds = raw.thresholds ?? DEFAULT_THRESHOLDS;
  if (
    !Array.isArray(thresholds) ||
    thresholds.length > 5 ||
    !thresholds.every((t) => Number.isInteger(t) && t >= 1 && t <= 1000)
  ) {
    throw new BudgetError("thresholds must be up to 5 whole percentages from 1 to 1000");
  }
  return {
    name,
    scope,
    scopeValue,
    period,
    windowStart,
    windowEnd,
    limitUsd,
    mode,
    reserveUsd: reserve === null || reserve === undefined ? undefined : (reserve as number),
    unknownPrice,
    thresholds: [...new Set(thresholds as number[])].sort((a, b) => a - b),
  };
}

/** The UTC window of `budget` that contains `at` (custom budgets have one fixed window). */
export function budgetWindow(budget: Budget, at: number): { start: number; end: number } {
  const d = new Date(at);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (budget.period) {
    case "day": {
      const start = Date.UTC(y, m, d.getUTCDate());
      return { start, end: start + DAY };
    }
    case "week": {
      const day = Date.UTC(y, m, d.getUTCDate());
      const start = day - ((d.getUTCDay() + 6) % 7) * DAY;
      return { start, end: start + 7 * DAY };
    }
    case "month":
      return { start: Date.UTC(y, m, 1), end: Date.UTC(y, m + 1, 1) };
    case "custom":
      return { start: budget.windowStart ?? 0, end: budget.windowEnd ?? 0 };
  }
}

/** SQL condition (on alias `e`) selecting the events a budget covers. */
function scopeClause(budget: Budget): { sql: string; params: SqlValue[] } {
  switch (budget.scope) {
    case "account":
      return { sql: "1 = 1", params: [] };
    case "project":
      return { sql: "e.project = ?", params: [budget.scopeValue] };
    case "provider":
      return { sql: "e.provider = ?", params: [budget.scopeValue] };
    case "model":
      return {
        sql: "coalesce(e.model_resolved, e.model_requested) = ?",
        params: [budget.scopeValue],
      };
    case "client":
      return { sql: "e.client_id = ?", params: [budget.scopeValue] };
    case "task":
      return { sql: "e.command = ?", params: [budget.scopeValue] };
  }
}

/** The facts of a job that decide which budgets cover it. */
export interface JobScope {
  provider: string;
  model: string | null;
  project: string | null;
  clientId: string | null;
  command: string;
}

function covers(budget: Budget, job: JobScope): boolean {
  switch (budget.scope) {
    case "account":
      return true;
    case "project":
      return job.project === budget.scopeValue;
    case "provider":
      return job.provider === budget.scopeValue;
    case "model":
      return job.model === budget.scopeValue;
    case "client":
      return job.clientId === budget.scopeValue;
    case "task":
      return job.command === budget.scopeValue;
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export type PreflightResult =
  | { ok: true; reservedUsd: number | null }
  | { ok: false; reason: "over_budget" | "unknown_price"; message: string; budgetId: string };

export class BudgetEngine {
  constructor(
    private readonly sql: SqlPort,
    private readonly now: () => number,
    private readonly activities: ActivityLog,
  ) {}

  list(): Budget[] {
    return this.sql
      .exec<BudgetRow>("SELECT * FROM budgets WHERE deleted_at IS NULL ORDER BY created_at")
      .map(toBudget);
  }

  get(id: string): Budget | null {
    const row = this.sql.exec<BudgetRow>(
      "SELECT * FROM budgets WHERE id = ? AND deleted_at IS NULL",
      id,
    )[0];
    return row ? toBudget(row) : null;
  }

  create(input: BudgetInput, actor: string): Budget {
    return this.sql.transaction(() => {
      const count = Number(
        this.sql.exec<{ n: number }>(
          "SELECT count(*) AS n FROM budgets WHERE deleted_at IS NULL",
        )[0]?.n ?? 0,
      );
      if (count >= MAX_BUDGETS) throw new BudgetError(`at most ${MAX_BUDGETS} budgets`);
      const id = `bud_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const at = this.now();
      this.write(id, input, at, at);
      this.activities.record({
        actor,
        kind: "budget.created",
        target: id,
        meta: { name: input.name, scope: input.scope, limitUsd: input.limitUsd, mode: input.mode },
      });
      return this.get(id) as Budget;
    });
  }

  update(id: string, input: BudgetInput, actor: string): Budget | null {
    return this.sql.transaction(() => {
      const current = this.get(id);
      if (!current) return null;
      this.write(id, input, current.createdAt, this.now());
      this.activities.record({
        actor,
        kind: "budget.updated",
        target: id,
        meta: { name: input.name, scope: input.scope, limitUsd: input.limitUsd, mode: input.mode },
      });
      return this.get(id);
    });
  }

  remove(id: string, actor: string): boolean {
    return this.sql.transaction(() => {
      if (!this.get(id)) return false;
      this.sql.exec("UPDATE budgets SET deleted_at = ? WHERE id = ?", this.now(), id);
      this.activities.record({ actor, kind: "budget.deleted", target: id });
      return true;
    });
  }

  private write(id: string, input: BudgetInput, createdAt: number, updatedAt: number): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO budgets (id, name, scope, scope_value, period, window_start, window_end,
        limit_usd, mode, reserve_usd, unknown_price, thresholds_json, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      id,
      input.name,
      input.scope,
      v(input.scopeValue),
      input.period,
      v(input.windowStart),
      v(input.windowEnd),
      input.limitUsd,
      input.mode,
      v(input.reserveUsd),
      input.unknownPrice,
      JSON.stringify(input.thresholds ?? DEFAULT_THRESHOLDS),
      createdAt,
      updatedAt,
    );
  }

  status(budget: Budget, at = this.now()): BudgetStatus {
    const window = budgetWindow(budget, at);
    const scope = scopeClause(budget);
    const row = this.sql.exec<{
      actual: number | null;
      estimated: number | null;
      adj: number | null;
      held: number | null;
      unknown_runs: number | null;
    }>(
      `SELECT
         sum(CASE WHEN e.actual_cost_usd IS NOT NULL THEN e.actual_cost_usd ELSE 0 END) AS actual,
         sum(CASE WHEN e.actual_cost_usd IS NULL AND e.estimated_cost_usd IS NOT NULL THEN e.estimated_cost_usd ELSE 0 END) AS estimated,
         sum((SELECT coalesce(sum(a.amount_usd), 0) FROM adjustments a WHERE a.event_id = e.id AND a.kind != 'billed')) AS adj,
         sum(CASE WHEN e.actual_cost_usd IS NULL AND e.estimated_cost_usd IS NULL
               THEN (SELECT coalesce(sum(r.amount_usd), 0) FROM reservations r WHERE r.job_id = e.id AND r.state IN ('held', 'uncertain'))
               ELSE 0 END) AS held,
         sum(CASE WHEN e.actual_cost_usd IS NULL AND e.estimated_cost_usd IS NULL AND e.charge_state IN ('charged', 'uncertain') THEN 1 ELSE 0 END) AS unknown_runs
       FROM usage_events e
       WHERE e.started_at >= ? AND e.started_at < ? AND ${scope.sql}`,
      window.start,
      window.end,
      ...scope.params,
    )[0];
    const actualUsd = round((row?.actual ?? 0) + (row?.adj ?? 0));
    const estimatedUsd = round(row?.estimated ?? 0);
    const heldUsd = round(row?.held ?? 0);
    const committedUsd = round(actualUsd + estimatedUsd + heldUsd);
    const elapsed = Math.min(at, window.end) - window.start;
    const forecastUsd =
      at >= window.start && at < window.end
        ? round((committedUsd / Math.max(elapsed, HOUR)) * (window.end - window.start))
        : null;
    const crossed = this.sql
      .exec<{ threshold: number }>(
        "SELECT threshold FROM budget_alerts WHERE budget_id = ? AND window_start = ? ORDER BY threshold",
        budget.id,
        window.start,
      )
      .map((r) => Number(r.threshold));
    return {
      budget,
      window,
      actualUsd,
      estimatedUsd,
      heldUsd,
      committedUsd,
      unknownRuns: Number(row?.unknown_runs ?? 0),
      percent: Math.round((committedUsd / budget.limitUsd) * 1000) / 10,
      forecastUsd,
      crossed,
    };
  }

  statuses(at = this.now()): BudgetStatus[] {
    return this.list().map((b) => this.status(b, at));
  }

  /**
   * Check the budgets that cover a job about to start and hold its price.
   * Call inside a transaction, after the job's `submitted` event exists so
   * the hold is counted against it.
   */
  preflight(jobId: string, job: JobScope, jobPrice: number | null, at: number): PreflightResult {
    const covering = this.list().filter((b) => {
      if (!covers(b, job)) return false;
      const w = budgetWindow(b, at);
      return at >= w.start && at < w.end;
    });
    const reserves = covering.map((b) => b.reserveUsd).filter((r): r is number => r !== null);
    const amount = jobPrice ?? (reserves.length ? Math.max(...reserves) : null);
    for (const budget of covering) {
      if (budget.mode !== "block") continue;
      const status = this.status(budget, at);
      if (amount === null && budget.unknownPrice === "block") {
        return {
          ok: false,
          reason: "unknown_price",
          budgetId: budget.id,
          message: `Budget "${budget.name}" blocks jobs without a known price; add a rate card price or a per-job reserve.`,
        };
      }
      if (
        status.committedUsd + (amount ?? 0) > budget.limitUsd ||
        status.committedUsd >= budget.limitUsd
      ) {
        return {
          ok: false,
          reason: "over_budget",
          budgetId: budget.id,
          message: `Budget "${budget.name}" would be exceeded: $${status.committedUsd.toFixed(2)} of $${budget.limitUsd.toFixed(2)} committed.`,
        };
      }
    }
    if (amount !== null) {
      this.sql.exec(
        "INSERT OR REPLACE INTO reservations (job_id, amount_usd, state, created_at, updated_at) VALUES (?, ?, 'held', ?, ?)",
        jobId,
        amount,
        at,
        at,
      );
    }
    return { ok: true, reservedUsd: amount };
  }

  /** Record each threshold a budget newly crossed in its current window. */
  checkAlerts(
    at = this.now(),
  ): Array<{ budgetId: string; threshold: number; committedUsd: number }> {
    const fired: Array<{ budgetId: string; threshold: number; committedUsd: number }> = [];
    for (const status of this.statuses(at)) {
      for (const threshold of status.budget.thresholds) {
        if (status.percent < threshold || status.crossed.includes(threshold)) continue;
        this.sql.exec(
          "INSERT OR IGNORE INTO budget_alerts (budget_id, window_start, threshold, fired_at, committed_usd) VALUES (?, ?, ?, ?, ?)",
          status.budget.id,
          status.window.start,
          threshold,
          at,
          status.committedUsd,
        );
        this.activities.record({
          actor: "system",
          kind: "budget.alert",
          target: status.budget.id,
          meta: {
            name: status.budget.name,
            threshold,
            committedUsd: status.committedUsd,
            limitUsd: status.budget.limitUsd,
          },
        });
        fired.push({ budgetId: status.budget.id, threshold, committedUsd: status.committedUsd });
      }
    }
    return fired;
  }
}
