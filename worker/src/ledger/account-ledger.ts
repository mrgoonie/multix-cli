/**
 * Durable Object holding one account's usage ledger (`MULTIX_LEDGER.getByName(userId)`),
 * so an account's operations, budgets and activities can only be read or
 * written through that account's own object. The logic lives in UsageLedger;
 * this class binds it to the object's SQLite storage and a daily alarm that
 * prunes rows past the retention period.
 */

import { DurableObject } from "cloudflare:workers";
import type {
  Activity,
  ActivityInput,
  Adjustment,
  AdjustmentKind,
  Budget,
  BudgetInput,
  BudgetStatus,
  GroupBy,
  Operation,
  OperationFilter,
  OperationInput,
  UsageSummary,
} from "./ledger-types.js";
import {
  type OperationPage,
  type RecordResult,
  type SqlPort,
  type SqlValue,
  UsageLedger,
} from "./usage-ledger.js";

const DAY_MS = 86_400_000;

interface DurableSql {
  exec(query: string, ...bindings: SqlValue[]): { toArray(): unknown[] };
}

interface DurableLedgerStorage {
  sql: DurableSql;
  transactionSync<T>(fn: () => T): T;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}

/** SqlPort over Durable Object SQLite storage; nested transactions join the outer one. */
export function durableSqlPort(storage: DurableLedgerStorage): SqlPort {
  let depth = 0;
  return {
    query: <T>(query: string, ...bindings: SqlValue[]) =>
      storage.sql.exec(query, ...bindings).toArray() as T[],
    transaction: <T>(fn: () => T): T => {
      if (depth > 0) return fn();
      depth++;
      try {
        return storage.transactionSync(fn);
      } finally {
        depth--;
      }
    },
  };
}

export type ActivityQuery = {
  from?: number;
  to?: number;
  kind?: string;
  q?: string;
  before?: number;
};

export class AccountLedger extends DurableObject<unknown> {
  private readonly storage = this.ctx.storage as unknown as DurableLedgerStorage;
  private readonly ledger = new UsageLedger(durableSqlPort(this.storage));

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      if ((await this.storage.getAlarm()) === null)
        await this.storage.setAlarm(Date.now() + DAY_MS);
    });
  }

  recordStart(input: OperationInput): RecordResult {
    return this.ledger.recordStart(input);
  }

  recordFinish(input: OperationInput): RecordResult {
    return this.ledger.recordFinish(input);
  }

  importOperations(
    inputs: OperationInput[],
    actor: string,
  ): { accepted: number; duplicates: number } {
    return this.ledger.importOperations(inputs, actor);
  }

  getOperation(opId: string): { operation: Operation; adjustments: Adjustment[] } | null {
    const operation = this.ledger.getOperation(opId);
    return operation ? { operation, adjustments: this.ledger.adjustmentsFor(opId) } : null;
  }

  listOperations(filter: OperationFilter, limit?: number, cursor?: string): OperationPage {
    return this.ledger.listOperations(filter, limit, cursor);
  }

  exportOperations(filter: OperationFilter, actor: string, format: string) {
    const result = this.ledger.exportOperations(filter);
    this.ledger.appendActivity({
      actor,
      kind: "usage.exported",
      subject: null,
      metadata: { format, rows: result.operations.length, truncated: result.truncated },
    });
    return result;
  }

  addAdjustment(
    opId: string,
    kind: AdjustmentKind,
    amountUsd: number,
    note: string | null,
    actor: string,
  ): Adjustment | null {
    return this.ledger.addAdjustment(opId, kind, amountUsd, note, actor);
  }

  summary(
    filter: OperationFilter & { from: number; to: number },
    groupBy: GroupBy | null,
    tzOffsetMinutes: number,
  ): UsageSummary {
    return this.ledger.summary(filter, groupBy, tzOffsetMinutes);
  }

  budgetStatuses(): BudgetStatus[] {
    return this.ledger.budgetStatuses();
  }

  budgetStatus(id: string): BudgetStatus | null {
    const budget = this.ledger.getBudget(id);
    return budget ? this.ledger.budgetStatus(budget) : null;
  }

  createBudget(input: BudgetInput, actor: string): Budget | null {
    return this.ledger.createBudget(input, actor);
  }

  updateBudget(id: string, input: BudgetInput, actor: string): Budget | null {
    return this.ledger.updateBudget(id, input, actor);
  }

  deleteBudget(id: string, actor: string): boolean {
    return this.ledger.deleteBudget(id, actor);
  }

  recordActivity(input: ActivityInput): Activity {
    return this.ledger.appendActivity(input);
  }

  listActivities(query: ActivityQuery, limit?: number) {
    return this.ledger.listActivities(query, limit);
  }

  verifyActivities() {
    return this.ledger.verifyActivities();
  }

  deleteAllData(actor: string): void {
    this.ledger.deleteAllData(actor);
  }

  storageStats() {
    return { ...this.ledger.storageStats(), schema_version: this.ledger.schemaVersion() };
  }

  /** Daily: drop rows older than the retention period, then schedule the next run. */
  override async alarm(): Promise<void> {
    this.ledger.prune();
    await this.storage.setAlarm(Date.now() + DAY_MS);
  }
}

type Rpc<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/** RPC surface of AccountLedger used by the Worker and the job Durable Object. */
export type AccountLedgerStub = Rpc<
  Pick<
    AccountLedger,
    | "recordStart"
    | "recordFinish"
    | "importOperations"
    | "getOperation"
    | "listOperations"
    | "exportOperations"
    | "addAdjustment"
    | "summary"
    | "budgetStatuses"
    | "budgetStatus"
    | "createBudget"
    | "updateBudget"
    | "deleteBudget"
    | "recordActivity"
    | "listActivities"
    | "verifyActivities"
    | "deleteAllData"
    | "storageStats"
  >
>;

export interface AccountLedgerNamespace {
  getByName(name: string): AccountLedgerStub;
}
