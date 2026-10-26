/**
 * Dashboard Overview: the last 30 days at a glance (KPIs, daily cost, top
 * models and providers, budgets, provider balances).
 */

import { escapeHtml } from "../http-responses.js";
import type { BudgetStatus, ProviderBalance, UsageSummary } from "../usage/usage-types.js";
import { type PageNotice, dashboardShell, hidden } from "./dashboard-nav.js";
import { costBarChart, progressBar } from "./svg-charts.js";
import { breakdownTable, kpiTiles, seriesBars } from "./usage-components.js";
import { count, money, utcTime } from "./usage-format.js";

export interface OverviewView {
  csrf: string;
  summary: UsageSummary;
  budgets: BudgetStatus[];
  balances: ProviderBalance[];
  notice?: PageNotice;
}

/** One budget's progress: committed against the limit, held, forecast, unknown runs. */
export function budgetProgress(s: BudgetStatus): string {
  const scope =
    s.budget.scope === "account"
      ? "whole account"
      : `${s.budget.scope} ${s.budget.scopeValue ?? ""}`;
  const forecast =
    s.forecastUsd === null
      ? ""
      : ` · forecast ${escapeHtml(money(s.forecastUsd))} by ${escapeHtml(utcTime(s.window.end))}`;
  const unknown =
    s.unknownRuns > 0
      ? ` · <span class="unknown">${count(s.unknownRuns)} runs with unknown cost</span>`
      : "";
  return `<div class="budget"><div class="row" style="justify-content:space-between"><strong>${escapeHtml(s.budget.name)}</strong><span><span class="badge">${escapeHtml(s.budget.mode)}</span> <span class="badge">${escapeHtml(s.budget.period)}</span></span></div>
<small class="muted">${escapeHtml(scope)}</small>
${progressBar(s.percent, `${s.budget.name}: ${s.percent}% of limit`)}
<small>${escapeHtml(money(s.committedUsd))} of ${escapeHtml(money(s.budget.limitUsd))} (${escapeHtml(String(s.percent))}%)${
    s.heldUsd > 0 ? ` · ${escapeHtml(money(s.heldUsd))} held` : ""
  }${forecast}${unknown}</small></div>`;
}

function balanceValue(b: ProviderBalance): string {
  const unit = b.unit ?? (b.kind === "cash" ? "USD" : "");
  const fmt = (n: number | null) =>
    n === null ? "–" : unit === "USD" ? money(n) : `${count(n)}${unit ? ` ${unit}` : ""}`;
  return `<td class="num">${escapeHtml(fmt(b.remaining))}</td><td class="num">${escapeHtml(fmt(b.used))}</td><td class="num">${escapeHtml(fmt(b.limit))}</td>`;
}

function balancesCard(view: OverviewView): string {
  const rows = view.balances
    .map(
      (b) =>
        `<tr><td>${escapeHtml(b.provider)}</td><td><span class="badge${b.status === "ok" ? " ok" : " off"}">${escapeHtml(b.status.replace("_", " "))}</span></td>${balanceValue(b)}<td>${escapeHtml(utcTime(b.checkedAt))}</td><td class="wrap"><small class="muted">${escapeHtml(b.detail ?? "")}</small></td></tr>`,
    )
    .join("");
  const table = rows
    ? `<div class="scroll"><table class="data"><thead><tr><th scope="col">Provider</th><th scope="col">Status</th><th scope="col" class="num">Remaining</th><th scope="col" class="num">Used</th><th scope="col" class="num">Limit</th><th scope="col">Checked (UTC)</th><th scope="col">Detail</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="muted">No balances checked yet.</p>`;
  return `<section class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Provider balances</h2>
<form method="post" action="/dashboard/balances/refresh">${hidden("csrf", view.csrf)}<button class="btn secondary small">Refresh balances</button></form></div>
<p class="muted"><small>Read from each provider with your saved keys, where the provider offers a balance endpoint.</small></p>
${table}</section>`;
}

export function overviewPage(view: OverviewView): string {
  const { summary } = view;
  const budgets = view.budgets.length
    ? view.budgets.map(budgetProgress).join("")
    : `<p class="muted">No budgets yet. <a href="/dashboard/budgets">Create one</a> to get alerts or block runaway jobs.</p>`;
  const body = `<h1>Overview</h1><p class="muted">Last 30 days, UTC. <a href="/dashboard/usage">Open Usage &amp; Costs</a> for filters and exports.</p>
${kpiTiles(summary.kpis)}
<section class="card"><h2>Daily cost</h2>${costBarChart(seriesBars(summary), "Daily cost, last 30 days")}</section>
<div class="grid2">
${breakdownTable("Top models", "Model", summary.breakdown.model.slice(0, 5))}
${breakdownTable("Top providers", "Provider", summary.breakdown.provider.slice(0, 5))}
</div>
<section class="card" style="margin-top:16px"><h2>Budgets</h2>${budgets}</section>
${balancesCard(view)}`;
  return dashboardShell("Overview", "overview", body, view.notice);
}
