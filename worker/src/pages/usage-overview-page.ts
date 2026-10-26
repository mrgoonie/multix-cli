/**
 * Dashboard overview: key usage numbers for this month (UTC) and the last 30
 * days, budget states, recent failures and the latest activities.
 */

import { escapeHtml } from "../http-responses.js";
import type { Activity, BudgetStatus, Operation, UsageTotals } from "../ledger/ledger-types.js";
import {
  count,
  dataTable,
  date,
  duration,
  finopsPage,
  knownCost,
  metadataText,
  money,
  percent,
  ratio,
  statusLabel,
  textOr,
  traceLink,
} from "./finops-format.js";

export interface OverviewView {
  month: UsageTotals;
  monthLabel: string;
  last30: UsageTotals;
  budgets: BudgetStatus[];
  failed: Operation[];
  activities: Activity[];
}

function kpi(label: string, value: string, note = "", attention = false): string {
  return `<div class="kpi${attention ? " attention" : ""}"><div class="label">${label}</div><div class="value">${value}</div>${note ? `<small class="muted">${note}</small>` : ""}</div>`;
}

export function kpiCards(totals: UsageTotals): string {
  const unknown = totals.unknown_cost_operations;
  const adjustments =
    totals.adjustments_usd !== 0 ? `, adjustments ${money(totals.adjustments_usd)}` : "";
  return `<div class="kpis">
${kpi("Known cost (USD)", knownCost(totals), `provider reported ${money(totals.provider_reported_cost_usd)}, estimated ${money(totals.estimated_cost_usd)}${adjustments}`)}
${kpi(
  "Operations with unknown cost",
  count(unknown),
  unknown > 0
    ? "The provider reported no cost for these, so the known cost above may be low."
    : "Every operation has a known cost.",
  unknown > 0,
)}
${kpi("Operations", count(totals.operations), `${count(totals.succeeded)} succeeded, ${count(totals.failed)} failed, ${count(totals.running)} running`)}
${kpi("Success rate", ratio(totals.success_rate), "of finished operations")}
${kpi("p95 latency", duration(totals.latency_p95_ms), `median ${duration(totals.latency_p50_ms)}`)}
${kpi("Outputs", count(totals.output_count))}
${kpi(
  "Cost per successful output",
  money(totals.cost_per_successful_output_usd),
  totals.cost_per_successful_output_usd === null
    ? "unknown while some costs are unknown or nothing succeeded with outputs"
    : "USD",
)}
</div>`;
}

export function budgetSummary(budgets: BudgetStatus[]): string {
  if (budgets.length === 0) {
    return '<p class="muted">No budgets yet. <a href="/dashboard/budgets">Create one</a> to get alerts.</p>';
  }
  const rows = budgets.map((b) => [
    `<a href="/dashboard/budgets#${escapeHtml(b.id)}">${escapeHtml(b.name)}</a>`,
    `<span class="state ${escapeHtml(b.state)}">${escapeHtml(b.state)}</span>`,
    percent(b.percent),
    `${money(b.spent_usd)} of ${money(b.limit_usd)}`,
    b.forecast_usd === null ? '<span class="muted">too early</span>' : money(b.forecast_usd),
    count(b.unknown_cost_operations),
  ]);
  return dataTable(
    ["Budget", "State", "Used", "Spent (USD)", "Forecast for the period", "Unknown-cost ops"],
    rows,
    [2, 4, 5],
  );
}

export function overviewPage(view: OverviewView): string {
  const failed = view.failed.length
    ? dataTable(
        ["Started", "Operation", "Provider", "Command", "Status", "Error"],
        view.failed.map((op) => [
          date(op.started_at),
          traceLink(op.op_id),
          escapeHtml(op.provider),
          escapeHtml(op.command),
          statusLabel(op.status),
          textOr(op.error_code ?? op.detail?.error ?? null),
        ]),
      )
    : '<p class="muted">No failed operations.</p>';
  const activities = view.activities.length
    ? dataTable(
        ["Time", "Kind", "Actor", "Subject", "Details"],
        view.activities.map((a) => [
          date(a.ts),
          `<code>${escapeHtml(a.kind)}</code>`,
          escapeHtml(a.actor),
          textOr(a.subject),
          metadataText(a.metadata),
        ]),
      )
    : '<p class="muted">No activity yet.</p>';
  return finopsPage(
    "Usage overview",
    "overview",
    `<section class="card"><h2>This month (${escapeHtml(view.monthLabel)}, UTC)</h2>${kpiCards(view.month)}</section>
<section class="card"><h2>Last 30 days</h2>${kpiCards(view.last30)}</section>
<section class="card"><h2>Budgets</h2>${budgetSummary(view.budgets)}<p class="muted"><small>Forecasts project this period's spend to its end at the current rate; they are estimates, not bills.</small></p></section>
<section class="card"><h2>Recent failures</h2>${failed}</section>
<section class="card"><h2>Latest activity</h2>${activities}<p><a href="/dashboard/activity">All activity</a></p></section>`,
  );
}
