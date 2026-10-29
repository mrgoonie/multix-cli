/**
 * Cost receipts and settlement (runtime-neutral). A receipt reconciles one run:
 * the pre-flight estimate, what the provider reported (USD, credits), the
 * actual cost and where it came from, and the variance. Missing data stays
 * `null` (unknown), never $0: a failed, partial or canceled run that already
 * sent a billable request is "uncertain", because the provider may have
 * charged it.
 *
 * Every receipt names a logical `operation_id`. One operation can span several
 * runs (submit, status polls, result download, a webhook replay); spend is
 * counted once per operation by `settleOperations`: distinct charge runs add
 * up, verbatim replays do not, a provider-reported figure settles the
 * operation, and adjustments (refunds, corrections) apply once. Credits follow
 * the same rule, so a status read that repeats a task's credits does not
 * count them a second time. The reservation/settlement pair is the contract a
 * budget ledger (the remote dashboard) uses to hold the high estimate before a
 * run and release it once the actual cost is known.
 */

import type { CostEstimate } from "./cost-estimate.js";
import { type PriceComponent, type PriceMeter, priceOf, resolveRate } from "./pricing-catalog.js";

export const COST_RECEIPT_SCHEMA = "multix.cost/v1";

export type CostStatus =
  /** Provider-reported cost, or proven $0 because nothing billable was sent. */
  | "settled"
  /** Measured usage priced with the catalog: close to, but not, the billed amount. */
  | "computed"
  /** A billable request was sent and the run failed, was cut off or partly failed. */
  | "uncertain"
  /** The run succeeded but there is no reported cost and no price for its usage. */
  | "unknown";

/** What the run did with money: sent a billable request, only read state, or nothing. */
export type CostRole = "charge" | "observation" | "none";

export interface CostReceipt {
  schema: typeof COST_RECEIPT_SCHEMA;
  operation_id: string;
  role: CostRole;
  status: CostStatus;
  reason?: string;
  currency: "USD";
  estimate?: Pick<
    CostEstimate,
    "status" | "low_usd" | "expected_usd" | "high_usd" | "upper_bound" | "reason"
  > & { rate_id?: string; source?: string; last_checked?: string };
  provider_reported: { cost_usd: number | null; credits: number | null };
  actual_usd: number | null;
  actual_source:
    | "provider_reported"
    | "computed_from_usage"
    | "no_request"
    /** Every billable request was refused with a 4xx: the provider did no work. */
    | "refused"
    | null;
  /** Units the actual was computed from (measured, not estimated). */
  measured?: Partial<Record<PriceMeter, number>>;
  /** actual - expected estimate, when both are known. */
  variance_usd: number | null;
  max_cost_usd?: number;
  policy?: string;
  at: string;
}

export interface ReceiptCall {
  method: string;
  status: number;
}

export interface ReceiptUsage {
  tokens?: { input?: number; output?: number };
  cost_usd?: number;
  credits?: number;
  metrics?: Record<string, number>;
}

export interface ReceiptInput {
  operation_id: string;
  outcome: "ok" | "failed" | "not_sent";
  provider: string;
  model?: string;
  calls: ReceiptCall[];
  usage?: ReceiptUsage;
  estimate?: CostEstimate;
  max_cost_usd?: number;
  policy?: string;
  at?: Date;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Requests that can start paid work (GET/HEAD only read state). */
export function isBillableMethod(method: string): boolean {
  return !/^(GET|HEAD|OPTIONS)$/i.test(method);
}

/** ElevenLabs models that spend half a credit per character (priced lower per character). */
const HALF_CREDIT_MODEL = /flash|turbo/i;

/** Units the provider says it billed, per meter, from the run's usage. */
export function measuredUnits(
  usage: ReceiptUsage | undefined,
  model?: string,
): Partial<Record<PriceMeter, number>> {
  const out: Partial<Record<PriceMeter, number>> = {};
  if (!usage) return out;
  const m = usage.metrics ?? {};
  const input = usage.tokens?.input ?? m["usage.total_input_tokens"];
  const output = usage.tokens?.output ?? m["usage.total_output_tokens"];
  if (input !== undefined) out.input_text_tokens = input;
  if (output !== undefined) out.output_audio_tokens = output;
  // ElevenLabs: x-character-count is the character count. character-cost may be
  // credits, which equal characters only on full-credit models; on Flash/Turbo
  // it could be half, so it is not read as characters there.
  const chars =
    m["header.x-character-count"] ??
    (model && HALF_CREDIT_MODEL.test(model) ? undefined : m["header.character-cost"]);
  if (chars !== undefined) out.characters = chars;
  const requests = m["request.count"];
  if (requests !== undefined) out.requests = requests;
  return out;
}

function computeActual(
  components: PriceComponent[],
  measured: Partial<Record<PriceMeter, number>>,
): number | undefined {
  let total = 0;
  for (const c of components) {
    const units = measured[c.meter];
    if (units === undefined) return undefined;
    total += priceOf(components, c.meter, units) ?? 0;
  }
  return components.length > 0 ? total : undefined;
}

function compactEstimate(e: CostEstimate): NonNullable<CostReceipt["estimate"]> {
  return {
    status: e.status,
    low_usd: e.low_usd,
    expected_usd: e.expected_usd,
    high_usd: e.high_usd,
    upper_bound: e.upper_bound,
    ...(e.reason ? { reason: e.reason } : {}),
    ...(e.rate
      ? { rate_id: e.rate.id, source: e.rate.source, last_checked: e.rate.last_checked }
      : {}),
  };
}

/** Reconcile one run into a receipt. */
export function buildCostReceipt(input: ReceiptInput): CostReceipt {
  const at = input.at ?? new Date();
  const sent = input.calls.filter((c) => c.status !== -1);
  const billable = sent.filter((c) => isBillableMethod(c.method));
  const role: CostRole = billable.length > 0 ? "charge" : sent.length > 0 ? "observation" : "none";
  const reportedUsd = input.usage?.cost_usd;
  const reportedCredits = input.usage?.credits;
  const measured = measuredUnits(input.usage, input.model);

  let status: CostStatus;
  let reason: string | undefined;
  let actual: number | null = null;
  let source: CostReceipt["actual_source"] = null;

  if (input.outcome === "not_sent" || sent.length === 0) {
    status = "settled";
    actual = 0;
    source = "no_request";
    reason = "No provider request was sent.";
  } else if (reportedUsd !== undefined) {
    status = "settled";
    actual = round6(reportedUsd);
    source = "provider_reported";
  } else {
    let computed: number | undefined;
    if (input.model && role === "charge") {
      const lookup = resolveRate(input.provider, input.model, at);
      if (lookup.ok) computed = computeActual(lookup.rate.components, measured);
    }
    // Cut off, timed out or a server error: the provider may have done (and
    // billed) the work. A 4xx refusal (bad input, auth, rate limit) is not billed.
    const refused = billable.every((c) => c.status >= 400 && c.status < 500 && c.status !== 408);
    const partial = billable.some((c) => c.status === 0 || c.status === 408 || c.status >= 500);
    if (role === "charge" && refused) {
      status = "settled";
      actual = 0;
      source = "refused";
      reason = "The provider refused every billable request (4xx), so it did no paid work.";
    } else if (input.outcome === "failed" && role === "charge") {
      status = "uncertain";
      reason =
        "The run failed after a billable request was sent; the provider may have charged it. Check its usage page.";
    } else if (partial && role === "charge") {
      status = "uncertain";
      reason = "Some billable requests failed or were cut off; they may have been charged.";
    } else if (computed !== undefined) {
      status = "computed";
      actual = round6(computed);
      source = "computed_from_usage";
    } else {
      status = "unknown";
      reason =
        role === "observation"
          ? "Status or download only; spend belongs to the operation's submit run."
          : "The provider reported no cost and there is no trusted price for the measured usage.";
    }
  }

  const expected = input.estimate?.expected_usd ?? null;
  return {
    schema: COST_RECEIPT_SCHEMA,
    operation_id: input.operation_id,
    role,
    status,
    ...(reason ? { reason } : {}),
    currency: "USD",
    ...(input.estimate ? { estimate: compactEstimate(input.estimate) } : {}),
    provider_reported: {
      cost_usd: reportedUsd === undefined ? null : round6(reportedUsd),
      credits: reportedCredits === undefined ? null : round6(reportedCredits),
    },
    actual_usd: actual,
    actual_source: source,
    ...(Object.keys(measured).length ? { measured } : {}),
    variance_usd:
      actual !== null && expected !== null && source !== "no_request" && source !== "refused"
        ? round6(actual - expected)
        : null,
    ...(input.max_cost_usd !== undefined ? { max_cost_usd: input.max_cost_usd } : {}),
    ...(input.policy ? { policy: input.policy } : {}),
    at: at.toISOString(),
  };
}

/** Logical operation id: caller-provided, else provider:job-id, else the run id. */
export function operationIdFor(opts: {
  explicit?: string;
  provider: string;
  providerIds: string[];
  runId: string;
}): string {
  const explicit = opts.explicit?.trim();
  if (explicit) return explicit.slice(0, 200);
  const id = opts.providerIds[0];
  if (opts.provider && id) return `${opts.provider}:${id}`.slice(0, 200);
  return `run:${opts.runId}`;
}

export interface CostAdjustment {
  operation_id: string;
  kind: "refund" | "correction";
  /** Negative for a refund. */
  usd: number;
  reason?: string;
  at: string;
}

export interface OperationSpend {
  operation_id: string;
  status: CostStatus;
  /** Provider-reported figure, else the sum of the known charges; adjustments included. */
  actual_usd: number | null;
  adjustments_usd: number;
  /** Provider-reported credits, counted like actual_usd; null when none were reported. */
  credits: number | null;
  runs: number;
}

export interface SpendSummary {
  operations: OperationSpend[];
  /** Known spend, each operation counted once; uncertain or unknown charges add nothing. */
  total_usd: number;
  /** Operations whose cost is uncertain or unknown: the total excludes them. */
  uncertain: number;
  unknown: number;
  /**
   * Reported credits, each operation once; null when no receipt reported any.
   * Includes operations known only from a status read, which have no entry in
   * `operations` (they carry no spend of their own).
   */
  total_credits: number | null;
}

/** Lower is less certain: an operation is only as certain as its least certain charge. */
const RANK: Record<CostStatus, number> = { settled: 3, computed: 2, uncertain: 1, unknown: 0 };

/** Receipts that say nothing about money spent: nothing was sent, or every request was refused. */
const isNoSpend = (r: CostReceipt) =>
  r.actual_source === "no_request" || r.actual_source === "refused";

/**
 * Spend per operation, counted once however many receipts mention it. Each
 * distinct charge run (a resubmit is billed again) adds its actual; a receipt
 * replayed verbatim (same run, same instant) counts once. A status read that
 * carries the provider's own figure settles the whole operation and replaces
 * the charges' sum. Runs that sent nothing or were refused never lower a
 * figure. The operation's status is that of its least certain charge.
 * Credits are settled the same way, by the latest status read that reports
 * them, else by the sum of the distinct charges; an operation known only from
 * a status read still counts its credits once.
 */
export function settleOperations(
  receipts: CostReceipt[],
  adjustments: CostAdjustment[] = [],
): SpendSummary {
  type Op = {
    runs: number;
    charges: Map<string, CostReceipt>;
    reported?: CostReceipt;
    reportedCredits?: CostReceipt;
    noSpendOnly: boolean;
  };
  const ops = new Map<string, Op>();
  for (const r of receipts) {
    const op: Op = ops.get(r.operation_id) ?? { runs: 0, charges: new Map(), noSpendOnly: true };
    op.runs++;
    ops.set(r.operation_id, op);
    if (isNoSpend(r)) continue;
    op.noSpendOnly = false;
    if (r.role === "charge") {
      op.charges.set(`${r.at}|${r.status}|${r.actual_usd}`, r);
    } else {
      if (r.status === "settled" && r.actual_usd !== null) {
        if (!op.reported || r.at >= op.reported.at) op.reported = r;
      }
      if (r.provider_reported.credits !== null) {
        if (!op.reportedCredits || r.at >= op.reportedCredits.at) op.reportedCredits = r;
      }
    }
  }
  const adjusted = new Map<string, number>();
  const seenAdjustment = new Set<string>();
  for (const a of adjustments) {
    const key = `${a.operation_id}|${a.kind}|${a.usd}|${a.at}`;
    if (seenAdjustment.has(key)) continue;
    seenAdjustment.add(key);
    adjusted.set(a.operation_id, round6((adjusted.get(a.operation_id) ?? 0) + a.usd));
  }
  const operations: OperationSpend[] = [];
  let totalCredits: number | null = null;
  for (const [operation_id, op] of ops) {
    if (op.noSpendOnly) continue;
    const charges = [...op.charges.values()];
    const chargedCredits = charges.filter((r) => r.provider_reported.credits !== null);
    const credits =
      op.reportedCredits?.provider_reported.credits ??
      (chargedCredits.length
        ? round6(chargedCredits.reduce((sum, r) => sum + (r.provider_reported.credits ?? 0), 0))
        : null);
    if (credits !== null) totalCredits = round6((totalCredits ?? 0) + credits);
    if (charges.length === 0 && !op.reported) continue;
    let status: CostStatus;
    let actual: number | null;
    if (op.reported) {
      status = "settled";
      actual = op.reported.actual_usd;
    } else {
      status = charges.reduce<CostStatus>(
        (worst, r) => (RANK[r.status] < RANK[worst] ? r.status : worst),
        "settled",
      );
      const known = charges.filter((r) => r.actual_usd !== null);
      actual = known.length ? known.reduce((sum, r) => sum + (r.actual_usd ?? 0), 0) : null;
    }
    const adjustments_usd = adjusted.get(operation_id) ?? 0;
    operations.push({
      operation_id,
      status,
      actual_usd: actual === null ? null : round6(actual + adjustments_usd),
      adjustments_usd,
      credits,
      runs: op.runs,
    });
  }
  return {
    operations,
    total_usd: round6(operations.reduce((s, op) => s + (op.actual_usd ?? 0), 0)),
    uncertain: operations.filter((op) => op.status === "uncertain").length,
    unknown: operations.filter((op) => op.status === "unknown").length,
    total_credits: totalCredits,
  };
}

/** Hold placed on a budget before a run: the estimate's ceiling. */
export interface BudgetReservation {
  operation_id: string;
  reserve_usd: number;
  upper_bound: "proven" | "estimated";
  policy: string;
  created_at: string;
}

export interface BudgetSettlement {
  operation_id: string;
  status: CostStatus;
  actual_usd: number | null;
  /** Part of the reservation released back to the budget (negative: overspend to charge). */
  release_usd: number;
  /** True while the cost is uncertain/unknown: the whole reservation stays held. */
  held: boolean;
  settled_at: string;
}

/** Settle a reservation with a run's receipt. Uncertain or unknown cost keeps the hold. */
export function settleReservation(
  reservation: BudgetReservation,
  receipt: CostReceipt,
  at: Date = new Date(),
): BudgetSettlement {
  const known =
    receipt.actual_usd !== null && (receipt.status === "settled" || receipt.status === "computed");
  return {
    operation_id: reservation.operation_id,
    status: receipt.status,
    actual_usd: receipt.actual_usd,
    release_usd: known ? round6(reservation.reserve_usd - (receipt.actual_usd ?? 0)) : 0,
    held: !known,
    settled_at: at.toISOString(),
  };
}
