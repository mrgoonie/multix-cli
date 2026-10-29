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
 *   grouping: a run that reports the provider's own verdict that the job
 *   failed (JOB_FAILED, CONTENT_BLOCKED) makes it failed, even when its
 *   submit was accepted and a later read-only poll exited ok, unless a run
 *   under the same operation id succeeded for another provider job (a
 *   resubmit under an explicit operation id); otherwise it is
 *   completed when any of its runs succeeded, else failed or canceled by its
 *   latest run. A poll that failed for any other reason (network, timeout)
 *   is not a failure of the job, even when it lands in another row (no
 *   resolved model, a status command); success rate and sample size count
 *   operations;
 * - retries are failed sends of the same submit before the one that returned
 *   the job (`job.attempt - 1`);
 * - spend is settled per operation (settleOperations): provider-reported
 *   figures settle it, uncertain or unknown costs stay out of the total and
 *   are counted instead, never added as $0;
 * - the model is the resolved model the provider ran; runs without one are
 *   grouped under "(unknown model)" rather than guessed from the command.
 *
 * Runtime-neutral: the caller reads the ledger.
 */

import type { HistoryEntry } from "../agent/history-store.js";
import type { CostReceipt } from "../budget/cost-receipt.js";
import { settleOperations } from "../budget/cost-receipt.js";
import { commandCapability } from "../capabilities/command-capabilities.js";

export const USAGE_GROUPS = ["provider", "model", "offering", "task", "command"] as const;
export type UsageGroup = (typeof USAGE_GROUPS)[number];

export const UNKNOWN_MODEL = "(unknown model)";

/**
 * The entry's cost receipt; entries written before receipts existed get one
 * from their provider-reported cost (one operation per run).
 */
export function receiptOf(e: HistoryEntry): CostReceipt | undefined {
  if (e.cost) return e.cost;
  if (e.usage?.cost_usd === undefined) return undefined;
  return {
    schema: "multix.cost/v1",
    operation_id: `run:${e.id}`,
    role: "charge",
    status: "settled",
    currency: "USD",
    provider_reported: { cost_usd: e.usage.cost_usd, credits: e.usage.credits ?? null },
    actual_usd: e.usage.cost_usd,
    actual_source: "provider_reported",
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
  return (
    receiptOf(e)?.operation_id ?? (e.job ? `job:${e.job.provider}:${e.job.id}` : `run:${e.id}`)
  );
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
/**
 * The provider's own verdict that the job failed, not a transient failure to
 * read it. CONTENT_BLOCKED counts only as the job's verdict, not as an HTTP
 * response (a gateway page saying "blocked" on a poll).
 */
const isJobFailure = (e: HistoryEntry) =>
  !e.ok &&
  (e.error?.code === "JOB_FAILED" ||
    (e.error?.code === "CONTENT_BLOCKED" && !/\bHTTP \d{3}\b/.test(e.error.message)));

/** Provider job ids a run names. */
const jobIdsOf = (e: HistoryEntry) => [...(e.provider_ids ?? []), ...(e.job ? [e.job.id] : [])];

/** Latest run by timestamp; ledger order breaks ties (it is append order). */
const latestOf = (runs: HistoryEntry[]) => runs.reduce((a, b) => (b.ts >= a.ts ? b : a));

type Outcome = "completed" | "failed" | "canceled";

/**
 * Outcome of each operation: failed if a run reported the provider failed
 * the job and no run succeeded for another job, else completed if any run
 * succeeded, else its latest run decides.
 */
function operationOutcomes(list: HistoryEntry[]): Map<string, Outcome> {
  const runs = new Map<string, HistoryEntry[]>();
  for (const e of list) {
    const id = operationOf(e);
    runs.set(id, [...(runs.get(id) ?? []), e]);
  }
  const outcomes = new Map<string, Outcome>();
  for (const [id, ops] of runs) {
    const failures = ops.filter(isJobFailure);
    if (failures.length > 0) {
      // The failure sticks to the jobs it names: a resubmit under the same explicit
      // operation id that returned another job can still complete the operation.
      const failed = new Set(failures.flatMap(jobIdsOf));
      const otherJobOk = ops.some((e) => {
        const ids = jobIdsOf(e);
        return e.ok && failed.size > 0 && ids.length > 0 && ids.every((j) => !failed.has(j));
      });
      outcomes.set(id, otherJobOk ? "completed" : "failed");
    } else if (ops.some((e) => e.ok)) outcomes.set(id, "completed");
    else outcomes.set(id, isCancel(latestOf(ops)) ? "canceled" : "failed");
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
  /** Operations with a successful run and no run reporting the provider failed the job. */
  completed: number;
  /** Operations a run reported the provider failed, or with no successful run whose latest run failed. */
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
  for (const e of sent) {
    const key = keyOf(e, by);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const rows: UsageRow[] = [];
  for (const [key, list] of groups) {
    const receipts = list.map(receiptOf).filter((r): r is CostReceipt => r !== undefined);
    const spend = settleOperations(receipts);
    const known = spend.operations.filter(
      (op) => op.actual_usd !== null && (op.status === "settled" || op.status === "computed"),
    );
    const sum = (ops: typeof known) => round(ops.reduce((s, op) => s + (op.actual_usd ?? 0), 0));
    const knownIds = new Set(known.map((op) => op.operation_id));
    // Estimates of operations still without a known cost: what they were expected to cost.
    const estimates = new Map<string, number>();
    for (const r of receipts) {
      const v = r.estimate?.expected_usd;
      if (!knownIds.has(r.operation_id) && typeof v === "number") estimates.set(r.operation_id, v);
    }
    const opIds = [...new Set(list.map(operationOf))];
    const ops = opIds.length;
    const count = (o: Outcome) => opIds.filter((id) => outcomes.get(id) === o).length;
    // Completed runs with no receipt at all (ledger entries before receipts): cost unknown.
    const unreceipted = new Set(list.filter((e) => e.ok && !receiptOf(e)).map(operationOf));
    const completedOps = new Set(opIds.filter((id) => outcomes.get(id) === "completed"));
    const allPriced =
      completedOps.size > 0 &&
      spend.unknown + spend.uncertain + unreceipted.size === 0 &&
      [...completedOps].every((id) => knownIds.has(id));
    const credits = list.reduce<number | undefined>(
      (s, e) => (e.usage?.credits === undefined ? s : (s ?? 0) + e.usage.credits),
      undefined,
    );
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
        unknown_operations: spend.unknown + unreceipted.size,
        uncertain_operations: spend.uncertain,
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
