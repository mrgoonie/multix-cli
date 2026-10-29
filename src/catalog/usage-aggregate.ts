/**
 * Usage intelligence from the local run ledger (~/.multix/history.jsonl):
 * what went through multix per provider, resolved model, task or command.
 * Only traffic sent through multix is counted, never the account's whole
 * usage at the provider.
 *
 * Counting rules:
 * - a request is one recorded run that sent something: dry runs,
 *   estimate-only runs and runs that made no provider request (a missing key,
 *   a bad flag, a receipt with role "none") are left out;
 * - an operation is one logical piece of work: runs that share a cost
 *   receipt operation id (submit, status polls, result download, resume)
 *   count once, so polls and resumes never double the operation count;
 * - outcomes are per operation, decided over the whole ledger before
 *   grouping: completed when any of its runs succeeded, otherwise failed or
 *   canceled by its latest run. A failed poll recorded under the job's
 *   operation is not a failure, even when it lands in another row (no
 *   resolved model, a status command); success rate and sample size count
 *   operations;
 * - retries are failed sends of the same submit before the one that returned
 *   the job (`job.attempt - 1`);
 * - spend (USD and credits) is settled per operation over the whole ledger
 *   (settleOperations) and shown on the operation's submit run
 *   (spendByEntry), so a status read that repeats a task's cost counts it
 *   once, in whichever row it lands; provider-reported figures settle it,
 *   uncertain or unknown costs stay out of the total and are counted
 *   instead, never added as $0;
 * - the model is the resolved model the provider ran; runs without one are
 *   grouped under "(unknown model)" rather than guessed from the command.
 *
 * Runtime-neutral: the caller reads the ledger.
 */

import type { HistoryEntry } from "../agent/history-store.js";
import type { CostReceipt, OperationSpend } from "../budget/cost-receipt.js";
import { operationIdFor, settleOperations } from "../budget/cost-receipt.js";
import { commandCapability } from "../capabilities/command-capabilities.js";

export const USAGE_GROUPS = ["provider", "model", "offering", "task", "command"] as const;
export type UsageGroup = (typeof USAGE_GROUPS)[number];

export const UNKNOWN_MODEL = "(unknown model)";

/**
 * Operation id of an entry with no receipt of its own, built the way receipts
 * build theirs (operationIdFor) from the job or the first provider id the run
 * saw, so the runs of one job join each other and newer runs of the job; a
 * run with neither is its own operation.
 */
function legacyOperationId(e: HistoryEntry): string {
  return operationIdFor({
    provider: e.provider,
    providerIds: e.job ? [e.job.id] : (e.provider_ids ?? []),
    runId: e.id,
  });
}

/**
 * The entry's cost receipt; entries written before receipts existed get one
 * from their provider-reported cost. Runs of one job share its operation and
 * read as status reads (the latest settles it), so a submit and a later
 * status run of the job count its cost once; a run with no provider id is
 * its own operation. Two old runs that each billed under one id would count
 * only the latest figure; no provider is known to do that.
 */
export function receiptOf(e: HistoryEntry): CostReceipt | undefined {
  if (e.cost) return e.cost;
  if (e.usage?.cost_usd === undefined) return undefined;
  const operation_id = legacyOperationId(e);
  return {
    schema: "multix.cost/v1",
    operation_id,
    role: operation_id.startsWith("run:") ? "charge" : "observation",
    status: "settled",
    currency: "USD",
    provider_reported: { cost_usd: e.usage.cost_usd, credits: e.usage.credits ?? null },
    actual_usd: e.usage.cost_usd,
    actual_source: "provider_reported",
    variance_usd: null,
    at: e.ts,
  };
}

/** What one operation spent, shown on the one ledger entry that owns it. */
export interface OwnedSpend {
  /** Settled USD of the operation; absent when no run reported or charged any. */
  spend?: OperationSpend;
  /** Settled credits of the operation; absent when no run reported any. */
  credits?: number;
}

/**
 * Each operation's spend (USD and credits) settled once over all of its runs
 * (settleOperations) and placed on one run: its first charge run (the submit,
 * which names the model), else its earliest run that reported a figure. A
 * status run of the same task then adds nothing to any row, even when it is
 * grouped apart from its submit (no model, another command). Spend is
 * settled per provider within an operation: one MULTIX_OPERATION_ID shared
 * across providers never mixes their credits, which are different units.
 * Entries without a receipt read as status reads of their job (or of their
 * own run when they have none).
 */
export function spendByEntry(entries: HistoryEntry[]): Map<HistoryEntry, OwnedSpend> {
  const out = new Map<HistoryEntry, OwnedSpend>();
  const byOp = new Map<string, { entry: HistoryEntry; receipt: CostReceipt }[]>();
  for (const entry of entries) {
    const receipt = receiptOf(entry) ?? legacyCreditsReceipt(entry);
    if (!receipt) continue;
    const key = `${entry.provider}|${receipt.operation_id}`;
    const runs = byOp.get(key);
    if (runs) runs.push({ entry, receipt });
    else byOp.set(key, [{ entry, receipt }]);
  }
  const sentNothing = (r: CostReceipt) =>
    r.actual_source === "no_request" || r.actual_source === "refused";
  const reported = (r: CostReceipt) =>
    !sentNothing(r) &&
    (r.provider_reported.credits !== null || (r.status === "settled" && r.actual_usd !== null));
  for (const runs of byOp.values()) {
    const summary = settleOperations(runs.map((r) => r.receipt));
    const spend = summary.operations[0];
    const credits = summary.total_credits;
    if (!spend && credits === null) continue;
    const charge = runs.find((r) => r.receipt.role === "charge" && !sentNothing(r.receipt));
    const owner =
      charge ??
      runs
        .filter((r) => reported(r.receipt))
        .reduce((earliest, r) => (r.receipt.at < earliest.receipt.at ? r : earliest));
    out.set(owner.entry, {
      ...(spend ? { spend } : {}),
      ...(credits !== null ? { credits } : {}),
    });
  }
  return out;
}

/** A credits-only stand-in receipt for an entry written before receipts existed. */
function legacyCreditsReceipt(e: HistoryEntry): CostReceipt | undefined {
  if (e.usage?.credits === undefined) return undefined;
  return {
    schema: "multix.cost/v1",
    operation_id: legacyOperationId(e),
    role: "observation",
    status: "unknown",
    currency: "USD",
    provider_reported: { cost_usd: null, credits: e.usage.credits },
    actual_usd: null,
    actual_source: null,
    variance_usd: null,
    at: e.ts,
  };
}

/** The model the provider reported running; never the requested or legacy `model` field. */
export function resolvedModel(e: HistoryEntry): string | undefined {
  return e.model_resolved ?? undefined;
}

/** Logical operation a run belongs to. */
export function operationOf(e: HistoryEntry): string {
  return receiptOf(e)?.operation_id ?? legacyOperationId(e);
}

export function keyOf(e: HistoryEntry, by: UsageGroup): string {
  if (by === "provider") return e.provider || "(none)";
  if (by === "command") return e.command || "(none)";
  if (by === "task") return commandCapability(e.command)?.tasks[0] ?? "(unclassified)";
  const model = resolvedModel(e);
  if (by === "offering") return model ? `${e.provider}:${model}` : `${e.provider}:${UNKNOWN_MODEL}`;
  return model ?? UNKNOWN_MODEL;
}

/**
 * False for runs that never reached the provider. A receipt states it (role
 * "none" sent nothing); without one, only recorded HTTP calls or provider ids
 * prove a send, whatever the outcome.
 */
export function sentRequest(e: HistoryEntry): boolean {
  if (e.dry_run || e.estimate_only) return false;
  const receipt = receiptOf(e);
  if (receipt) return receipt.role !== "none";
  return (e.http?.requests ?? 0) > 0 || Boolean(e.provider_ids?.length);
}

const isCancel = (e: HistoryEntry) => e.error?.code === "CANCELLED";

type Outcome = "completed" | "failed" | "canceled";

/** Outcome of each operation: completed if any run succeeded, else its latest run decides. */
function operationOutcomes(list: HistoryEntry[]): Map<string, Outcome> {
  const runs = new Map<string, HistoryEntry[]>();
  for (const e of list) {
    const id = operationOf(e);
    runs.set(id, [...(runs.get(id) ?? []), e]);
  }
  const outcomes = new Map<string, Outcome>();
  for (const [id, ops] of runs) {
    if (ops.some((e) => e.ok)) outcomes.set(id, "completed");
    else {
      // Latest by timestamp; ledger order breaks ties (it is append order).
      const latest = ops.reduce((a, b) => (b.ts >= a.ts ? b : a));
      outcomes.set(id, isCancel(latest) ? "canceled" : "failed");
    }
  }
  return outcomes;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const v = sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  return Math.round(v / 100) / 10;
}

/** How far a figure from `n` samples can be trusted. */
export function confidence(n: number): "none" | "low" | "medium" | "high" {
  if (n === 0) return "none";
  if (n < 5) return "low";
  if (n < 30) return "medium";
  return "high";
}

const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

export interface UsageRow {
  key: string;
  /** Recorded runs that sent something (attempts and status reads included). */
  requests: number;
  /** Logical operations (a job and its polls/resumes count once). */
  operations: number;
  /** Operations with a successful run. */
  completed: number;
  /** Operations with no successful run whose latest run failed. */
  failed: number;
  /** Operations with no successful run whose latest run was canceled. */
  canceled: number;
  /** completed / operations, null without operations. */
  success_rate: number | null;
  /** Failed sends of a submit before the one that returned the job. */
  retries: number;
  p50_s: number | null;
  p95_s: number | null;
  outputs: number;
  cost: {
    /** Known spend, each operation once (settled + computed). */
    known_usd: number;
    /** Part of known_usd the provider reported itself. */
    provider_reported_usd: number;
    /** Part of known_usd priced from measured usage with the price book. */
    computed_usd: number;
    /** Pre-flight expected estimate of operations with no known cost (not spend). */
    estimated_usd: number | null;
    /** Operations whose cost stays unknown or uncertain (not counted as $0). */
    unknown_operations: number;
    uncertain_operations: number;
    /** known_usd / successful operations, only when no operation's cost is unknown or uncertain. */
    per_success_usd: number | null;
  };
  credits?: number;
  first_at: string;
  last_at: string;
  sample: { n: number; confidence: ReturnType<typeof confidence> };
}

/** Aggregate ledger entries by one dimension, busiest first. */
export function aggregateUsage(entries: HistoryEntry[], by: UsageGroup): UsageRow[] {
  const sent = entries.filter(sentRequest);
  // Decided once over every row: the runs of one operation can fall under different keys.
  const outcomes = operationOutcomes(sent);
  const groups = new Map<string, HistoryEntry[]>();
  const owned = spendByEntry(sent);
  const spends = [...owned.values()].flatMap((o) => (o.spend ? [o.spend] : []));
  const isKnown = (op: OperationSpend) =>
    op.actual_usd !== null && (op.status === "settled" || op.status === "computed");
  const knownIds = new Set(spends.filter(isKnown).map((op) => op.operation_id));
  // Completed runs with no receipt at all (ledger entries before receipts): cost unknown,
  // counted once on the operation's first such run. An operation a receipt accounts for is not unknown.
  const accounted = new Set(spends.map((op) => op.operation_id));
  const unreceipted = new Map<string, HistoryEntry>();
  for (const e of sent) {
    const id = operationOf(e);
    if (e.ok && !receiptOf(e) && !accounted.has(id) && !unreceipted.has(id)) unreceipted.set(id, e);
  }
  const unreceiptedRuns = new Set(unreceipted.values());
  for (const e of sent) {
    const key = keyOf(e, by);
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  const rows: UsageRow[] = [];
  for (const [key, list] of groups) {
    // Each operation's spend lands in the row of the run that owns it.
    const rowSpends = list.flatMap((e) => {
      const s = owned.get(e)?.spend;
      return s ? [s] : [];
    });
    const known = rowSpends.filter(isKnown);
    const sum = (ops: typeof known) => round(ops.reduce((s, op) => s + (op.actual_usd ?? 0), 0));
    const rowKnownIds = new Set(known.map((op) => op.operation_id));
    const unknownOps =
      rowSpends.filter((op) => op.status === "unknown").length +
      list.filter((e) => unreceiptedRuns.has(e)).length;
    const uncertainOps = rowSpends.filter((op) => op.status === "uncertain").length;
    // Estimates of operations still without a known cost: what they were expected to cost.
    const estimates = new Map<string, number>();
    for (const e of list) {
      const r = receiptOf(e);
      const v = r?.estimate?.expected_usd;
      if (r && !knownIds.has(r.operation_id) && typeof v === "number") {
        estimates.set(r.operation_id, v);
      }
    }
    const opIds = [...new Set(list.map(operationOf))];
    const ops = opIds.length;
    const count = (o: Outcome) => opIds.filter((id) => outcomes.get(id) === o).length;
    const completedOps = new Set(opIds.filter((id) => outcomes.get(id) === "completed"));
    // Per success only when this row holds the known cost of every operation it completed.
    const allPriced =
      completedOps.size > 0 &&
      unknownOps + uncertainOps === 0 &&
      [...completedOps].every((id) => rowKnownIds.has(id));
    const credits = list.reduce<number | undefined>((s, e) => {
      const c = owned.get(e)?.credits;
      return c === undefined ? s : (s ?? 0) + c;
    }, undefined);
    const durations = list.map((e) => e.duration_ms);
    const times = list.map((e) => e.ts).sort();
    rows.push({
      key,
      requests: list.length,
      operations: ops,
      completed: completedOps.size,
      failed: count("failed"),
      canceled: count("canceled"),
      success_rate: ops ? round(completedOps.size / ops, 3) : null,
      retries: list.reduce((s, e) => s + Math.max(0, (e.job?.attempt ?? 1) - 1), 0),
      p50_s: percentile(durations, 50),
      p95_s: percentile(durations, 95),
      outputs: list.reduce((s, e) => s + (e.outputs?.length ?? 0), 0),
      cost: {
        known_usd: sum(known),
        provider_reported_usd: sum(known.filter((op) => op.status === "settled")),
        computed_usd: sum(known.filter((op) => op.status === "computed")),
        estimated_usd: estimates.size
          ? round([...estimates.values()].reduce((a, b) => a + b, 0))
          : null,
        unknown_operations: unknownOps,
        uncertain_operations: uncertainOps,
        per_success_usd: allPriced ? round(sum(known) / completedOps.size) : null,
      },
      ...(credits !== undefined ? { credits: round(credits) } : {}),
      first_at: times[0] ?? "",
      last_at: times.at(-1) ?? "",
      sample: { n: ops, confidence: confidence(ops) },
    });
  }
  return rows.sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key));
}
