/**
 * Usage & Costs (filters, KPIs, time series, breakdowns, events, exports)
 * and the Traces list (the same filters over the event list).
 */

import { escapeHtml } from "../http-responses.js";
import { filterParams } from "../usage/usage-queries.js";
import type { UsageEvent, UsageFilter, UsageSummary } from "../usage/usage-types.js";
import { type PageNotice, dashboardShell } from "./dashboard-nav.js";
import { costBarChart } from "./svg-charts.js";
import {
  breakdownTable,
  eventTable,
  filterForm,
  kpiTiles,
  pager,
  seriesBars,
} from "./usage-components.js";

export interface EventPage {
  items: UsageEvent[];
  next: string | null;
  cursor: string | null;
}

export interface UsageView {
  filter: UsageFilter;
  range: string;
  summary: UsageSummary;
  events: EventPage;
  notice?: PageNotice;
}

const BUCKET_LABEL = { hour: "Hourly", day: "Daily", week: "Weekly" } as const;

export function usagePage(view: UsageView): string {
  const { filter, summary } = view;
  const path = "/dashboard/usage";
  const exportParams = (format: "csv" | "json") => {
    const p = new URLSearchParams({ format });
    for (const [k, v] of filterParams(filter)) p.set(k, v);
    return `/dashboard/usage/export?${p}`;
  };
  const dims: Array<[keyof UsageSummary["breakdown"], string, string]> = [
    ["provider", "By provider", "Provider"],
    ["model", "By model", "Model"],
    ["source", "By source", "Source"],
    ["command", "By command", "Command"],
    ["client", "By client", "Client"],
    ["project", "By project", "Project"],
    ["status", "By status", "Status"],
  ];
  const body = `<h1>Usage &amp; Costs</h1>
${filterForm(path, filter, view.range)}
${kpiTiles(summary.kpis)}
<section class="card"><h2>${BUCKET_LABEL[summary.bucket]} cost</h2>${costBarChart(seriesBars(summary), `${BUCKET_LABEL[summary.bucket]} cost for the selected range`)}</section>
<div class="grid2">
${dims.map(([d, title, column]) => breakdownTable(title, column, summary.breakdown[d], { path, filter, dimension: d })).join("\n")}
</div>
<section class="card" style="margin-top:16px"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Runs</h2>
<div class="row"><a class="btn secondary small" href="${escapeHtml(exportParams("csv"))}" download>Export CSV</a><a class="btn secondary small" href="${escapeHtml(exportParams("json"))}" download>Export JSON</a></div></div>
<p class="muted"><small>Newest first. Exports hold up to 10,000 runs of the current filter; each export is recorded in Activities.</small></p>
${eventTable(view.events.items)}
${pager(path, filter, view.events.cursor, view.events.next)}
</section>`;
  return dashboardShell("Usage & Costs", "usage", body, view.notice);
}

export interface TracesView {
  filter: UsageFilter;
  range: string;
  events: EventPage;
  notice?: PageNotice;
}

export function tracesPage(view: TracesView): string {
  const path = "/dashboard/traces";
  const body = `<h1>Traces</h1><p class="muted">Every run with its timing and cost facts. Open one to see its span waterfall, outputs and adjustments.</p>
${filterForm(path, view.filter, view.range)}
<section class="card">${eventTable(view.events.items)}${pager(path, view.filter, view.events.cursor, view.events.next)}</section>`;
  return dashboardShell("Traces", "traces", body, view.notice);
}
