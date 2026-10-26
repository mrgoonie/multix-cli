/**
 * Budgets: status bars for every budget of the account, a create form and
 * per-budget edit and delete forms. Budgets raise alerts (activities) only;
 * they do not stop jobs.
 */

import { escapeHtml } from "../http-responses.js";
import { BUDGET_PERIODS, BUDGET_SCOPE_KINDS, type BudgetStatus } from "../ledger/ledger-types.js";
import {
  count,
  date,
  finopsPage,
  hiddenCsrf,
  money,
  noticeHtml,
  options,
  percent,
} from "./finops-format.js";

/** Budget form fields as strings, for re-display after a validation error. */
export interface BudgetFormValues {
  name: string;
  scope_kind: string;
  scope_value: string;
  period: string;
  limit_usd: string;
  thresholds: string;
}

export const EMPTY_BUDGET_FORM: BudgetFormValues = {
  name: "",
  scope_kind: "account",
  scope_value: "",
  period: "month",
  limit_usd: "",
  thresholds: "50, 80, 100",
};

export interface BudgetsView {
  budgets: BudgetStatus[];
  csrf: string;
  notice?: { text: string; warn?: boolean };
  /** Values of a rejected create form (re-displayed in the create form). */
  draft?: BudgetFormValues;
}

export function budgetFormValues(b: BudgetStatus): BudgetFormValues {
  return {
    name: b.name,
    scope_kind: b.scope_kind,
    scope_value: b.scope_value ?? "",
    period: b.period,
    limit_usd: String(b.limit_usd),
    thresholds: b.thresholds.join(", "),
  };
}

function budgetForm(action: string, csrf: string, v: BudgetFormValues, submit: string): string {
  return `<form method="post" action="${escapeHtml(action)}">${hiddenCsrf(csrf)}
<div class="form-grid">
<label>Name<input type="text" name="name" required maxlength="80" value="${escapeHtml(v.name)}"></label>
<label>Scope<select name="scope_kind">${options(BUDGET_SCOPE_KINDS, v.scope_kind)}</select></label>
<label>Scope value <small>(empty for account)</small><input type="text" name="scope_value" maxlength="200" value="${escapeHtml(v.scope_value)}" placeholder="e.g. gemini"></label>
<label>Period<select name="period">${options(BUDGET_PERIODS, v.period)}</select></label>
<label>Limit (USD)<input type="text" name="limit_usd" inputmode="decimal" required value="${escapeHtml(v.limit_usd)}" placeholder="25"></label>
<label>Alert at (% of limit)<input type="text" name="thresholds" value="${escapeHtml(v.thresholds)}" placeholder="50, 80, 100"></label>
</div>
<button class="btn small">${escapeHtml(submit)}</button></form>`;
}

function budgetCard(b: BudgetStatus, csrf: string): string {
  const scope = b.scope_value ? `${b.scope_kind}: ${b.scope_value}` : b.scope_kind;
  const width = Math.max(0, Math.min(100, b.percent)).toFixed(1);
  const alerts = b.alerts.length
    ? b.alerts.map((a) => `${escapeHtml(String(a))}%`).join(", ")
    : '<span class="muted">none</span>';
  const unknown =
    b.unknown_cost_operations > 0
      ? `<p class="notice warn">${count(b.unknown_cost_operations)} operation(s) in scope have an unknown cost, so the spend shown may be low.</p>`
      : "";
  const id = escapeHtml(b.id);
  return `<section class="card" id="${id}">
<div class="row" style="justify-content:space-between"><h2 style="margin:0">${escapeHtml(b.name)}</h2><span class="state ${escapeHtml(b.state)}">${escapeHtml(b.state)}</span></div>
<p class="muted"><small>${escapeHtml(scope)} · per ${escapeHtml(b.period)} · period ${date(b.period_start)} to ${date(b.period_end)}</small></p>
<div class="meter ${escapeHtml(b.state)}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${escapeHtml(width)}" aria-label="Budget used"><span style="width:${width}%"></span></div>
<p>${money(b.spent_usd)} of ${money(b.limit_usd, true)} spent (${percent(b.percent)}). Forecast for the period: ${b.forecast_usd === null ? '<span class="muted">too early to forecast</span>' : `${money(b.forecast_usd, true)} <small class="muted">(a projection, not a bill)</small>`}.</p>
<p>Alerts raised this period: ${alerts} <small class="muted">(thresholds ${escapeHtml(b.thresholds.join(", "))}%)</small></p>
${unknown}
<details><summary>Edit or delete</summary>
${budgetForm(`/dashboard/budgets/${b.id}`, csrf, budgetFormValues(b), "Save budget")}
<form method="post" action="/dashboard/budgets/${id}/delete" style="margin-top:8px">${hiddenCsrf(csrf)}<button class="btn danger small">Delete budget</button></form>
</details>
</section>`;
}

export function budgetsPage(view: BudgetsView): string {
  const list = view.budgets.length
    ? view.budgets.map((b) => budgetCard(b, view.csrf)).join("")
    : '<section class="card"><p class="muted">No budgets yet.</p></section>';
  return finopsPage(
    "Budgets",
    "budgets",
    `${noticeHtml(view.notice)}<section class="card"><h1>Budgets</h1>
<p>A budget tracks the known cost of a scope (the whole account, a provider, model, command, source, client or project) per day, week or month (UTC) and records an alert in the activity log the first time each threshold is crossed in a period.</p>
<p class="notice warn">Budgets alert only: they do not block or stop jobs yet.</p></section>
${list}
<section class="card"><h2>New budget</h2>${budgetForm("/dashboard/budgets", view.csrf, view.draft ?? EMPTY_BUDGET_FORM, "Create budget")}<p class="muted"><small>An account can hold up to 20 budgets.</small></p></section>`,
  );
}
