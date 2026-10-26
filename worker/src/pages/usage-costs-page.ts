/**
 * Usage & costs: GET filter form, daily cost chart, breakdown by a chosen
 * group, export links for the same filters, and the "delete all usage data"
 * form.
 */

import { escapeHtml } from "../http-responses.js";
import {
  GROUP_BYS,
  OPERATION_SOURCES,
  OPERATION_STATUSES,
  type UsageSummary,
  type UsageTotals,
} from "../ledger/ledger-types.js";
import {
  UNKNOWN,
  count,
  dataTable,
  duration,
  finopsPage,
  hiddenCsrf,
  knownCost,
  money,
  noticeHtml,
  options,
  ratio,
} from "./finops-format.js";
import { costChart } from "./usage-chart.js";
import { kpiCards } from "./usage-overview-page.js";

/** The filter form's values as submitted (or the defaults), for re-display. */
export interface UsageFormValues {
  from: string;
  to: string;
  provider: string;
  model: string;
  source: string;
  status: string;
  command: string;
  group_by: string;
}

export interface UsageView {
  form: UsageFormValues;
  summary: UsageSummary | null;
  /** Validation error of the filters, shown instead of the results. */
  error?: string;
  /** Query string (without `format`) reproducing these filters for the export links. */
  exportQuery: string;
  csrf: string;
  notice?: { text: string; warn?: boolean };
}

function filterForm(form: UsageFormValues): string {
  const input = (name: keyof UsageFormValues, label: string, type = "text") =>
    `<label>${label}<input type="${type}" name="${name}" value="${escapeHtml(form[name])}"${type === "text" ? ' maxlength="200"' : ""}></label>`;
  return `<form method="get" action="/dashboard/usage" class="filters">
${input("from", "From (UTC)", "date")}
${input("to", "To (UTC, inclusive)", "date")}
${input("provider", "Provider")}
${input("model", "Model")}
${input("command", "Command")}
<label>Source<select name="source">${options(OPERATION_SOURCES, form.source, "any")}</select></label>
<label>Status<select name="status">${options(OPERATION_STATUSES, form.status, "any")}</select></label>
<label>Group by<select name="group_by">${options(GROUP_BYS, form.group_by)}</select></label>
<button class="btn small">Apply</button>
<a class="btn secondary small" href="/dashboard/usage">Reset</a>
</form>`;
}

const allUnknown = (t: UsageTotals) =>
  t.operations > 0 && t.unknown_cost_operations === t.operations;

function breakdown(summary: UsageSummary): string {
  if (summary.groups.length === 0) return '<p class="muted">No operations match these filters.</p>';
  const rows = summary.groups.map((g) => [
    g.key === null ? '<span class="muted">unknown</span>' : escapeHtml(g.key),
    count(g.operations),
    ratio(g.success_rate),
    knownCost(g),
    allUnknown(g) ? UNKNOWN : money(g.provider_reported_cost_usd),
    allUnknown(g) ? UNKNOWN : money(g.estimated_cost_usd),
    count(g.unknown_cost_operations),
    duration(g.latency_p95_ms),
    count(g.output_count),
  ]);
  return dataTable(
    [
      escapeHtml(summary.group_by ?? "group"),
      "Operations",
      "Success",
      "Known cost (USD)",
      "Provider reported",
      "Estimated",
      "Unknown-cost ops",
      "p95 latency",
      "Outputs",
    ],
    rows,
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
}

export function usageCostsPage(view: UsageView): string {
  const { summary } = view;
  const q = view.exportQuery ? `&${view.exportQuery}` : "";
  const results = summary
    ? `<section class="card"><h2>Totals</h2>${kpiCards(summary.totals)}</section>
<section class="card"><h2>Daily known cost</h2>${costChart(summary)}</section>
<section class="card"><h2>Breakdown by ${escapeHtml(summary.group_by ?? "group")}</h2>${breakdown(summary)}
<p class="row"><a class="btn secondary small" href="/dashboard/usage/export?format=csv${escapeHtml(q)}">Export CSV</a><a class="btn secondary small" href="/dashboard/usage/export?format=json${escapeHtml(q)}">Export JSON</a><small class="muted">Exports hold the operations matching these filters (at most 10,000 rows); each export is recorded in the activity log.</small></p></section>`
    : "";
  const error = view.error ? noticeHtml({ text: view.error, warn: true }) : "";
  return finopsPage(
    "Usage & costs",
    "usage",
    `${noticeHtml(view.notice)}<section class="card"><h1>Usage &amp; costs</h1>
<p class="muted">Known cost adds provider-reported and estimated costs and adjustments. Operations whose cost no one reported are counted separately and never as $0.</p>
${filterForm(view.form)}${error}</section>
${results}
<section class="card"><h2>Delete all usage data</h2>
<p>Removes every operation, adjustment, budget alert and activity of this account from the usage ledger. Budgets themselves are kept. This cannot be undone; export first to keep a copy.</p>
<form method="post" action="/dashboard/usage/delete" class="row">${hiddenCsrf(view.csrf)}
<label>Type DELETE to confirm <input type="text" name="confirm" autocomplete="off" required pattern="DELETE" style="flex:0 1 160px"></label>
<button class="btn danger small">Delete all usage data</button></form></section>`,
  );
}
