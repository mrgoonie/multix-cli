/**
 * Everything the Worker asks of one account's usage ledger, as one object
 * over a SqlPort. AccountUsage (the Durable Object) forwards its RPC methods
 * here; tests run it on an in-memory SQLite database.
 *
 * Caller mistakes come back as `{ ok: false, error }` rather than thrown,
 * because an error thrown across Durable Object RPC loses its type.
 */

import type { ActivityQuery } from "./activity-log.js";
import { BudgetError, parseBudgetInput } from "./budget-engine.js";
import { RateCardError, parseRateCard } from "./rate-card.js";
import type { SqlPort } from "./sql-port.js";
import { type Adjustment, UsageInputError, UsageLedger } from "./usage-ledger.js";
import { UsageQueries } from "./usage-queries.js";
import type {
  Activity,
  ActivityInput,
  BeginInput,
  BeginResult,
  Budget,
  BudgetStatus,
  ImportResult,
  ProviderBalance,
  RateCardEntry,
  SettleInput,
  UsageEvent,
  UsageFilter,
  UsageSummary,
} from "./usage-types.js";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function attempt<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    if (
      error instanceof BudgetError ||
      error instanceof RateCardError ||
      error instanceof UsageInputError
    ) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

export interface EventDetail {
  event: UsageEvent;
  adjustments: Adjustment[];
  /** A captured stderr tail exists (read it with readDebugLog). */
  hasDebugLog: boolean;
}

/** Small summary for agents (`multix_usage`). */
export interface UsageDigest {
  from: number;
  to: number;
  kpis: UsageSummary["kpis"];
  topModels: UsageSummary["breakdown"]["model"];
  topProviders: UsageSummary["breakdown"]["provider"];
  budgets: Array<{
    id: string;
    name: string;
    scope: string;
    scopeValue: string | null;
    mode: string;
    limitUsd: number;
    committedUsd: number;
    percent: number;
    forecastUsd: number | null;
    unknownRuns: number;
  }>;
}

interface BalanceRow {
  provider: string;
  status: string;
  checked_at: number;
  kind: string | null;
  unit: string | null;
  remaining: number | null;
  used: number | null;
  limit_value: number | null;
  detail: string | null;
  [key: string]: string | number | null;
}

export class UsageService {
  readonly ledger: UsageLedger;
  readonly queries: UsageQueries;

  constructor(sql: SqlPort, now: () => number = Date.now) {
    this.ledger = new UsageLedger(sql, now);
    this.queries = new UsageQueries(sql);
  }

  begin(input: BeginInput): BeginResult {
    return this.ledger.begin(input);
  }

  release(jobId: string, code: string, reason: string): void {
    this.ledger.release(jobId, code, reason);
  }

  settle(input: SettleInput): UsageEvent | null {
    return this.ledger.settle(input);
  }

  importCli(entries: unknown, project: string | undefined, actor: string): Result<ImportResult> {
    return attempt(() => this.ledger.importCli(entries, { project, actor }));
  }

  adjust(eventId: string, input: unknown, actor: string): Result<Adjustment | null> {
    return attempt(() => this.ledger.adjust(eventId, input, actor));
  }

  summary(filter: UsageFilter, tzOffsetMinutes = 0): UsageSummary {
    return this.queries.summary(filter, tzOffsetMinutes);
  }

  digest(filter: UsageFilter): UsageDigest {
    const kpis = this.queries.kpis(filter);
    return {
      from: filter.from,
      to: filter.to,
      kpis,
      topModels: this.queries.breakdown(filter, "model").slice(0, 5),
      topProviders: this.queries.breakdown(filter, "provider").slice(0, 5),
      budgets: this.budgets().map((s) => ({
        id: s.budget.id,
        name: s.budget.name,
        scope: s.budget.scope,
        scopeValue: s.budget.scopeValue,
        mode: s.budget.mode,
        limitUsd: s.budget.limitUsd,
        committedUsd: s.committedUsd,
        percent: s.percent,
        forecastUsd: s.forecastUsd,
        unknownRuns: s.unknownRuns,
      })),
    };
  }

  events(
    filter: UsageFilter,
    cursor: string | null,
    limit?: number,
  ): Result<{ items: UsageEvent[]; next: string | null }> {
    try {
      return { ok: true, value: this.queries.events(filter, cursor, limit) };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  event(id: string): EventDetail | null {
    const event = this.queries.event(id);
    if (!event) return null;
    const debug = this.ledger.sql.exec(
      "SELECT 1 AS x FROM debug_logs WHERE event_id = ? AND expires_at > ?",
      id,
      this.ledger.now(),
    );
    return { event, adjustments: this.ledger.adjustments(id), hasDebugLog: debug.length > 0 };
  }

  exportEvents(
    filter: UsageFilter,
    actor: string,
    format: "csv" | "json",
  ): { items: UsageEvent[]; truncated: boolean } {
    const result = this.queries.export(filter);
    this.ledger.activities.record({
      actor,
      kind: "usage.exported",
      meta: { format, rows: result.items.length, truncated: result.truncated },
    });
    return result;
  }

  budgets(): BudgetStatus[] {
    return this.ledger.budgets.statuses();
  }

  createBudget(input: unknown, actor: string): Result<Budget> {
    return attempt(() => this.ledger.budgets.create(parseBudgetInput(input), actor));
  }

  updateBudget(id: string, input: unknown, actor: string): Result<Budget | null> {
    return attempt(() => {
      const current = this.ledger.budgets.get(id);
      if (!current) return null;
      const merged = { ...current, ...((input ?? {}) as object) };
      return this.ledger.budgets.update(id, parseBudgetInput(merged), actor);
    });
  }

  deleteBudget(id: string, actor: string): boolean {
    return this.ledger.budgets.remove(id, actor);
  }

  activities(query: ActivityQuery): { items: Activity[]; next: number | null } {
    return this.ledger.activities.list(query);
  }

  verifyActivities(): { ok: boolean; checked: number; brokenAtSeq: number | null } {
    return this.ledger.activities.verify();
  }

  recordActivity(input: ActivityInput): void {
    this.ledger.activities.record(input);
  }

  rateCard(): RateCardEntry[] {
    return this.ledger.rateCard.list();
  }

  replaceRateCard(entries: unknown, actor: string): Result<RateCardEntry[]> {
    return attempt(() => {
      const parsed = parseRateCard(entries);
      this.ledger.sql.transaction(() => {
        this.ledger.rateCard.replace(parsed);
        this.ledger.activities.record({
          actor,
          kind: "rate_card.replaced",
          meta: { entries: parsed.length },
        });
      });
      return this.ledger.rateCard.list();
    });
  }

  balances(): ProviderBalance[] {
    return this.ledger.sql
      .exec<BalanceRow>("SELECT * FROM balances ORDER BY provider")
      .map((r) => ({
        provider: r.provider,
        status: r.status as ProviderBalance["status"],
        checkedAt: r.checked_at,
        kind: r.kind as ProviderBalance["kind"],
        unit: r.unit,
        remaining: r.remaining,
        used: r.used,
        limit: r.limit_value,
        detail: r.detail,
      }));
  }

  saveBalances(balances: ProviderBalance[], actor: string): void {
    this.ledger.sql.transaction(() => {
      // A refresh replaces the whole set: a provider whose key was removed drops out.
      this.ledger.sql.exec("DELETE FROM balances");
      for (const b of balances) {
        this.ledger.sql.exec(
          `INSERT INTO balances (provider, status, checked_at, kind, unit, remaining, used, limit_value, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          b.provider,
          b.status,
          b.checkedAt,
          b.kind,
          b.unit,
          b.remaining,
          b.used,
          b.limit,
          b.detail,
        );
      }
      this.ledger.activities.record({
        actor,
        kind: "balances.refreshed",
        meta: { providers: balances.length },
      });
    });
  }

  debugCaptureUntil(): number {
    return this.ledger.debugCaptureUntil();
  }

  setDebugCapture(enabled: boolean, actor: string): number {
    return this.ledger.setDebugCapture(enabled, actor);
  }

  readDebugLog(eventId: string, actor: string): string | null {
    return this.ledger.readDebugLog(eventId, actor);
  }

  deleteUsage(actor: string): number {
    return this.ledger.deleteUsage(actor);
  }

  prune(): void {
    this.ledger.prune();
  }
}
