/**
 * Cost flags for the CLI process: `--estimate` (price the run, send nothing),
 * `--max-cost <usd>` with `--cost-policy` (refuse before sending when the cost
 * cannot be kept under the limit), and the receipt every provider run gets in
 * its result envelope and history entry. The pricing logic itself is
 * runtime-neutral (src/budget) and shared with the MCP Worker.
 */

import {
  type CostPolicy,
  checkBudget,
  estimateCommand,
  parseCostPolicy,
  parseMaxCost,
  pricedCommands,
} from "../budget/command-cost.js";
import type { CostEstimate } from "../budget/cost-estimate.js";
import { type CostReceipt, buildCostReceipt, operationIdFor } from "../budget/cost-receipt.js";
import { BudgetError } from "../core/errors.js";
import { getDefaultModel } from "../providers/gemini/models.js";
import { run } from "./run-state.js";

export interface BudgetCheck {
  ok: boolean;
  max_cost_usd: number;
  policy: CostPolicy;
  code?: string;
  message?: string;
}

/** Defaults a command resolves at run time (env overrides), not in commander. */
function runtimeDefaults(command: string): { model?: string } {
  if (command === "gemini generate-speech") return { model: getDefaultModel("generate-speech") };
  return {};
}

/**
 * Before the action: price the run when asked (or when it is priceable) and
 * apply --max-cost. Throws BudgetError when the guard refuses; returns true
 * when the run is estimate-only and must stop here.
 */
export function preflightCost(): boolean {
  const o = run.options;
  const estimateOnly = Boolean(o.estimate);
  const hasMax = o.maxCost !== undefined;
  const maxCost = hasMax ? parseMaxCost(o.maxCost) : undefined;
  const policy = parseCostPolicy(o.costPolicy);
  if (estimateOnly || hasMax || pricedCommands().includes(run.command)) {
    run.estimate = estimateCommand(run.command, o, runtimeDefaults(run.command));
  }
  if (maxCost !== undefined && run.estimate) {
    run.maxCost = maxCost;
    run.costPolicy = policy;
    try {
      checkBudget(run.estimate, maxCost, policy);
      run.budget = { ok: true, max_cost_usd: maxCost, policy };
    } catch (error) {
      if (!(error instanceof BudgetError)) throw error;
      run.budget = {
        ok: false,
        max_cost_usd: maxCost,
        policy,
        code: error.code,
        message: error.message,
      };
      // An estimate-only run reports the verdict instead of failing.
      if (!estimateOnly) throw error;
    }
  }
  return estimateOnly;
}

/** The run's receipt, or undefined for commands that never call a provider. */
export function costReceiptFor(opts: {
  failed: boolean;
  notSent: boolean;
  historyId?: string;
  model?: string;
  usage?: Parameters<typeof buildCostReceipt>[0]["usage"];
}): CostReceipt | undefined {
  if (!run.group) return undefined;
  return buildCostReceipt({
    operation_id: operationIdFor({
      explicit: process.env.MULTIX_OPERATION_ID,
      provider: run.group,
      providerIds: run.ids,
      runId: opts.historyId ?? `h_${run.startedAt.toString(36)}`,
    }),
    outcome: opts.notSent ? "not_sent" : opts.failed ? "failed" : "ok",
    provider: run.group,
    model: opts.model,
    // A provider's own CLI spends quota without a fetch call: count it as a
    // billable request whose cost multix cannot see.
    calls: [...run.calls, ...run.externalRuns.map(() => ({ method: "EXEC", status: 200 }))],
    usage: opts.usage,
    estimate: run.estimate,
    max_cost_usd: run.maxCost,
    policy: run.maxCost !== undefined ? run.costPolicy : undefined,
  });
}

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "unknown";
  if (n === 0) return "$0";
  return `$${n < 0.01 ? n.toPrecision(3).replace(/0+$/, "").replace(/\.$/, "") : n.toFixed(4)}`;
}

/** Human pre-flight block for `--estimate`. */
export function formatEstimate(e: CostEstimate, budget?: BudgetCheck): string {
  const lines: string[] = [];
  if (e.status !== "estimated") {
    lines.push(`Estimate: unknown (${e.reason}) — ${e.detail}`);
  } else {
    lines.push(
      `Estimate: ${usd(e.expected_usd)} expected, ${usd(e.low_usd)}–${usd(e.high_usd)} range (${e.upper_bound === "proven" ? "proven ceiling" : "high end is an estimate, not a cap"})`,
    );
    lines.push(`  model: ${e.provider} ${e.model}`);
    const counted = Object.entries(e.units)
      .map(([meter, r]) => `${meter} ${r.low === r.high ? r.expected : `${r.low}–${r.high}`}`)
      .join(", ");
    lines.push(
      `  text: ${e.text.characters} characters (${e.text.nfc_characters} after NFC), ${e.text.utf8_bytes} UTF-8 bytes`,
    );
    if (counted) lines.push(`  units: ${counted}`);
    if (e.rate) {
      const window = e.rate.effective_until ? `, until ${e.rate.effective_until}` : "";
      lines.push(
        `  rate: ${e.rate.id} (${e.rate.label ?? "list"}${window}), checked ${e.rate.last_checked}, ${e.rate.source}`,
      );
    }
    for (const a of e.assumptions) lines.push(`  note: ${a}`);
  }
  if (budget) {
    lines.push(
      budget.ok
        ? `  budget: within --max-cost ${usd(budget.max_cost_usd)} (policy ${budget.policy})`
        : `  budget: ${budget.code} — ${budget.message}`,
    );
  }
  lines.push("  Nothing was sent; no provider was billed.");
  return `${lines.join("\n")}\n`;
}

/** One-line receipt after a provider run (text mode); undefined when there is nothing to say. */
export function formatReceipt(r: CostReceipt): string | undefined {
  if (r.actual_source === "no_request") return undefined;
  if (r.status === "unknown" && !r.estimate) return undefined;
  const parts: string[] = [];
  if (r.status === "uncertain") parts.push(`uncertain — ${r.reason}`);
  else if (r.actual_usd !== null) {
    parts.push(
      `${usd(r.actual_usd)} ${r.actual_source === "provider_reported" ? "(provider reported)" : "(computed from usage at list price)"}`,
    );
  } else parts.push("actual unknown");
  if (r.estimate?.status === "estimated") {
    parts.push(`estimate ${usd(r.estimate.low_usd)}–${usd(r.estimate.high_usd)}`);
  }
  if (r.variance_usd !== null)
    parts.push(`variance ${r.variance_usd >= 0 ? "+" : "-"}${usd(Math.abs(r.variance_usd))}`);
  if (r.provider_reported.credits !== null)
    parts.push(`${r.provider_reported.credits} credits reported`);
  if (r.estimate?.rate_id)
    parts.push(`rate ${r.estimate.rate_id} checked ${r.estimate.last_checked}`);
  return `Cost: ${parts.join(" · ")}\n`;
}
