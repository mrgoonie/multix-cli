/**
 * Usage per provider, resolved model, task or command, from run ledger
 * entries (the local `history.jsonl`, or any list of entries of that shape).
 *
 * Three counts are kept apart so polls, resumes and retries never inflate a
 * figure: runs (CLI invocations: a submit and a later `status --wait` are two),
 * operations (one logical job: those runs share a cost operation id or a
 * provider job id) and attempts (provider sends, including retries before the
 * job id came back). Success is per operation. Spend counts each operation
 * once (settleOperations); estimates are reported apart from actual figures,
 * and an operation with neither stays unknown, never $0. A model is keyed by
 * the model the provider resolved when it reported one.
 *
 * Runtime-neutral: it only reads the entries it is given.
 */

import type { HistoryEntry } from "../agent/history-store.js";
import { type CostReceipt, settleOperations } from "../budget/cost-receipt.js";
import { commandCapability } from "../capabilities/command-capabilities.js";
import { CATALOG_SCHEMA } from "./catalog-types.js";

export type UsageGroupBy = "provider" | "model" | "task" | "command";

/** How much a figure drawn from `n` operations can be leaned on. */
export type SampleConfidence = "insufficient" | "low" | "medium" | "high";

export function sampleConfidence(n: number): SampleConfidence {
  return n < 5 ? "insufficient" : n < 20 ? "low" : n < 100 ? "medium" : "high";
}

/**
 * The entry's cost receipt; entries written before receipts existed get one
 * from their provider-reported cost. On a provider job that figure is the
 * job's total, reported again by every poll or resume, so it is an
 * observation of the job's operation (the latest one wins), not a new charge.
 */
export function receiptOf(e: HistoryEntry): CostReceipt | undefined {
  if (e.cost) return e.cost;
  if (e.usage?.cost_usd === undefined) return undefined;
  return {
    schema: "multix.cost/v1",
    operation_id: operationOf(e),
    role: e.job ? "observation" : "charge",
    status: "settled",
    currency: "USD",
    provider_reported: { cost_usd: e.usage.cost_usd, credits: e.usage.credits ?? null },
    actual_usd: e.usage.cost_usd,
    actual_source: "provider_reported",
    variance_usd: null,
    at: e.ts,
  };
}

/** Logical operation of an entry: its cost operation, else its provider job, else the run. */
export function operationOf(e: HistoryEntry): string {
  if (e.cost?.operation_id) return e.cost.operation_id;
  if (e.job) return `${e.job.provider}:${e.job.id}`;
  return `run:${e.id}`;
}

export function resolvedModelOf(e: HistoryEntry): string | undefined {
  return e.model_resolved ?? e.model ?? e.model_requested ?? undefined;
}

export function taskOf(command: string): string {
  const tasks = commandCapability(command)?.tasks ?? [];
  return tasks.length ? tasks.join("|") : "(none)";
}

function keyOf(e: HistoryEntry, by: UsageGroupBy): string {
  if (by === "provider") return e.provider || "(none)";
  if (by === "command") return e.command || "(none)";
  if (by === "task") return taskOf(e.command);
  return `${e.provider || "(none)"}:${resolvedModelOf(e) ?? "(unknown model)"}`;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export interface UsageRow {
  key: string;
  runs: number;
  operations: number;
  attempts: number;
  completed: number;
  failed: number;
  canceled: number;
  /** completed / operations; null without operations. */
  success_rate: number | null;
  /** Share of attempts that were retries of a send. */
  retry_rate: number | null;
  /** Wall time per run, seconds. */
  latency_s: { p50: number; p95: number } | null;
  outputs: number;
  cost: {
    /** Known spend (settled or computed from measured usage), each operation once. */
    actual_usd: number | null;
    /** Expected estimate of operations with no actual figure. */
    estimated_usd: number | null;
    actual_ops: number;
    estimated_only_ops: number;
    uncertain_ops: number;
    unknown_ops: number;
  };
  /** Known spend / completed operations, only when every completed operation has a known cost. */
  cost_per_success_usd: number | null;
  credits?: number;
  /** model key: how the model was identified across runs. */
  model_identity?: { resolved: number; requested_only: number; missing: number };
  sample: { operations: number; confidence: SampleConfidence };
  first_at: string;
  last_at: string;
}

export interface UsageReport {
  schema: typeof CATALOG_SCHEMA;
  scope: "local-history";
  by: UsageGroupBy;
  rows: UsageRow[];
  totals: Omit<UsageRow, "key" | "model_identity">;
  note: string;
}

interface Op {
  entries: HistoryEntry[];
}

function summarise(key: string, entries: HistoryEntry[], withIdentity: boolean): UsageRow {
  const live = entries.filter((e) => !e.dry_run && !e.estimate_only);
  const ops = new Map<string, Op>();
  for (const e of live) {
    const id = operationOf(e);
    const op = ops.get(id) ?? { entries: [] };
    op.entries.push(e);
    ops.set(id, op);
  }
  let completed = 0;
  let canceled = 0;
  let attempts = 0;
  const done = new Set<string>();
  for (const [id, op] of ops) {
    attempts += Math.max(1, ...op.entries.map((e) => e.job?.attempt ?? 1));
    if (op.entries.some((e) => e.ok)) {
      completed++;
      done.add(id);
    } else if (op.entries.at(-1)?.error?.code === "CANCELLED") canceled++;
  }
  const receipts = live.map(receiptOf).filter((r): r is CostReceipt => r !== undefined);
  const spend = settleOperations(receipts);
  const actualByOp = new Map(spend.operations.map((o) => [o.operation_id, o]));
  let estimated = 0;
  let estimatedOps = 0;
  for (const [id, op] of ops) {
    if (actualByOp.get(id)?.actual_usd != null) continue;
    const expected = op.entries
      .map((e) => e.cost?.estimate?.expected_usd)
      .filter((v): v is number => typeof v === "number");
    if (expected.length) {
      estimated += Math.max(...expected);
      estimatedOps++;
    }
  }
  const actualOps = spend.operations.filter((o) => o.actual_usd !== null).length;
  const unknownOps = [...ops.keys()].filter(
    (id) =>
      actualByOp.get(id)?.actual_usd == null &&
      !ops.get(id)?.entries.some((e) => typeof e.cost?.estimate?.expected_usd === "number"),
  ).length;
  const everyDonePriced = [...done].every((id) => actualByOp.get(id)?.actual_usd != null);
  const durations = live.map((e) => e.duration_ms);
  const credits = live.reduce<number | undefined>(
    (sum, e) => (e.usage?.credits === undefined ? sum : (sum ?? 0) + e.usage.credits),
    undefined,
  );
  const n = ops.size;
  const ts = entries.map((e) => e.ts).sort();
  return {
    key,
    runs: live.length,
    operations: n,
    attempts,
    completed,
    failed: n - completed - canceled,
    canceled,
    success_rate: n ? round(completed / n, 3) : null,
    retry_rate: attempts ? round((attempts - n) / attempts, 3) : null,
    latency_s: durations.length
      ? {
          p50: round(percentile(durations, 50) / 1000, 1),
          p95: round(percentile(durations, 95) / 1000, 1),
        }
      : null,
    outputs: [...ops.values()].reduce(
      (sum, op) => sum + Math.max(0, ...op.entries.map((e) => e.outputs?.length ?? 0)),
      0,
    ),
    cost: {
      actual_usd: actualOps ? round(spend.total_usd, 6) : null,
      estimated_usd: estimatedOps ? round(estimated, 6) : null,
      actual_ops: actualOps,
      estimated_only_ops: estimatedOps,
      uncertain_ops: spend.uncertain,
      unknown_ops: unknownOps,
    },
    cost_per_success_usd:
      completed && actualOps && everyDonePriced ? round(spend.total_usd / completed, 6) : null,
    ...(credits !== undefined ? { credits: round(credits, 6) } : {}),
    ...(withIdentity
      ? {
          model_identity: {
            resolved: live.filter((e) => e.model_resolved).length,
            requested_only: live.filter((e) => !e.model_resolved && (e.model ?? e.model_requested))
              .length,
            missing: live.filter((e) => !e.model_resolved && !e.model && !e.model_requested).length,
          },
        }
      : {}),
    sample: { operations: n, confidence: sampleConfidence(n) },
    first_at: ts[0] ?? "",
    last_at: ts.at(-1) ?? "",
  };
}

/**
 * Group entries by `by`. Runs of one operation stay in one group: the group of
 * the operation's latest run decides, so a resume that resolves the model
 * moves the whole operation to the resolved model rather than splitting it.
 */
export function usageReport(entries: HistoryEntry[], by: UsageGroupBy): UsageReport {
  const latest = new Map<string, HistoryEntry>();
  for (const e of entries) {
    const id = operationOf(e);
    const prev = latest.get(id);
    if (!prev || e.ts >= prev.ts) latest.set(id, e);
  }
  const groups = new Map<string, HistoryEntry[]>();
  for (const e of entries) {
    const owner = latest.get(operationOf(e)) ?? e;
    const key = keyOf(owner, by);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const rows = [...groups.entries()]
    .map(([key, list]) => summarise(key, list, by === "model"))
    .filter((r) => r.runs > 0)
    .sort((a, b) => b.operations - a.operations || a.key.localeCompare(b.key));
  const { key: _key, model_identity: _identity, ...totals } = summarise("total", entries, false);
  return {
    schema: CATALOG_SCHEMA,
    scope: "local-history",
    by,
    rows,
    totals,
    note: "Traffic run through multix on this machine only, not the provider account's whole usage. Dry runs and estimates are excluded; unknown costs stay null.",
  };
}
