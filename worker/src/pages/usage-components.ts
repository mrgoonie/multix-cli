/**
 * Building blocks shared by the Overview, Usage & Costs and Traces pages:
 * KPI tiles, the GET filter form, breakdown tables and the event table.
 */

import { escapeHtml } from "../http-responses.js";
import { filterParams } from "../usage/usage-queries.js";
import {
  USAGE_SOURCES,
  USAGE_STATUSES,
  type UsageBreakdownRow,
  type UsageEvent,
  type UsageFilter,
  type UsageKpis,
  type UsageSummary,
} from "../usage/usage-types.js";
import type { CostBar } from "./svg-charts.js";
import {
  EST_HTML,
  count,
  durationText,
  eventCostHtml,
  isoDay,
  knownWithUnknown,
  money,
  percentText,
  statusHtml,
  utcTime,
} from "./usage-format.js";

export const RANGE_PRESETS = ["24h", "7d", "30d", "90d"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

function tile(label: string, value: string, sub = ""): string {
  return `<div class="kpi"><div class="label">${escapeHtml(label)}</div><div class="value">${value}</div>${
    sub ? `<div class="sub">${sub}</div>` : ""
  }</div>`;
}

/** KPI tiles; values are the ledger's own numbers (usage-queries.ts). */
export function kpiTiles(k: UsageKpis): string {
  const split = `${escapeHtml(money(k.actualUsd))} reported · ${escapeHtml(money(k.estimatedUsd))}${EST_HTML}${
    k.adjustmentsUsd !== 0 ? ` · ${escapeHtml(money(k.adjustmentsUsd))} adj.` : ""
  }`;
  const perOutput = k.costPerOutputUsd === null ? "–" : escapeHtml(money(k.costPerOutputUsd));
  return `<div class="kpis">
${tile("Known cost", escapeHtml(money(k.knownUsd)), split)}
${tile(
  "Unknown-cost runs",
  k.unknownCostRuns > 0 ? `<span class="unknown">${count(k.unknownCostRuns)}</span>` : "0",
  "May have cost money; no price known",
)}
${tile("Uncertain runs", count(k.uncertainRuns), "Reached a provider, then failed or stopped")}
${tile("Jobs", count(k.jobs), `${count(k.succeeded)} ok · ${count(k.failed)} failed · ${count(k.rejected)} rejected`)}
${tile("Success rate", percentText(k.successRate), "Of finished runs")}
${tile("Duration p50 / p95", `${escapeHtml(durationText(k.p50Ms))} / ${escapeHtml(durationText(k.p95Ms))}`)}
${tile("Credits", k.credits === null ? "–" : escapeHtml(count(k.credits)), "Provider credits reported")}
${tile("Cost per output", perOutput, "Succeeded runs with a known cost")}
</div>`;
}

/** Series buckets as chart bars; `knownUsd` already includes estimates and adjustments. */
export function seriesBars(summary: UsageSummary): CostBar[] {
  return summary.series.map((b) => ({
    label: summary.bucket === "hour" ? b.key.slice(11, 16) : b.key.slice(5, 10),
    title: summary.bucket === "week" ? `Week of ${b.key}` : b.key,
    actualUsd: Math.max(0, Math.round((b.knownUsd - b.estimatedUsd) * 1e6) / 1e6),
    estimatedUsd: b.estimatedUsd,
    unknownCostRuns: b.unknownCostRuns,
    jobs: b.jobs,
  }));
}

/** Which query parameter narrows the view to one row of a breakdown. */
const DIMENSION_PARAM: Record<keyof UsageSummary["breakdown"], string> = {
  provider: "provider",
  model: "model",
  source: "source",
  command: "command",
  client: "client",
  project: "project",
  status: "status",
};

export function breakdownTable(
  title: string,
  column: string,
  rows: UsageBreakdownRow[],
  link?: { path: string; filter: UsageFilter; dimension: keyof UsageSummary["breakdown"] },
): string {
  if (rows.length === 0) {
    return `<section class="card"><h2>${escapeHtml(title)}</h2><p class="muted">No runs.</p></section>`;
  }
  const body = rows
    .map((r) => {
      let key = escapeHtml(r.key);
      if (link && r.key !== "(none)") {
        const params = filterParams(link.filter);
        params.set(DIMENSION_PARAM[link.dimension], r.key);
        key = `<a href="${escapeHtml(`${link.path}?${params}`)}">${key}</a>`;
      }
      return `<tr><td class="wrap">${key}</td><td class="num">${count(r.jobs)}</td><td class="num">${count(r.succeeded)}</td><td class="num">${knownWithUnknown(r.knownUsd, r.unknownCostRuns)}</td><td class="num">${escapeHtml(durationText(r.avgMs))}</td></tr>`;
    })
    .join("");
  return `<section class="card"><h2>${escapeHtml(title)}</h2><div class="scroll"><table class="data"><thead><tr><th scope="col">${escapeHtml(column)}</th><th scope="col" class="num">Jobs</th><th scope="col" class="num">OK</th><th scope="col" class="num">Known cost</th><th scope="col" class="num">Avg time</th></tr></thead><tbody>${body}</tbody></table></div></section>`;
}

function option(value: string, label: string, selected: boolean): string {
  return `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function textInput(
  name: string,
  label: string,
  value: string | undefined,
  placeholder = "",
): string {
  return `<label>${escapeHtml(label)}<input type="text" name="${name}" value="${escapeHtml(value ?? "")}" maxlength="128" placeholder="${escapeHtml(placeholder)}" spellcheck="false"></label>`;
}

/** GET filter form; `range` is a preset or `custom` (then from/to apply). */
export function filterForm(path: string, filter: UsageFilter, range: string): string {
  const presets: Array<[string, string]> = [
    ["24h", "Last 24 hours"],
    ["7d", "Last 7 days"],
    ["30d", "Last 30 days"],
    ["90d", "Last 90 days"],
    ["custom", "Custom (from/to)"],
  ];
  return `<section class="card"><form method="get" action="${escapeHtml(path)}" class="filters" aria-label="Filters">
<label>Range<select name="range">${presets.map(([v, l]) => option(v, l, v === range)).join("")}</select></label>
<label>From (UTC)<input type="date" name="from" value="${isoDay(filter.from)}"></label>
<label>To (UTC, inclusive)<input type="date" name="to" value="${isoDay(filter.to - 1)}"></label>
${textInput("provider", "Provider", filter.provider, "gemini")}
${textInput("model", "Model", filter.model)}
<label>Source<select name="source">${option("", "Any", !filter.source)}${USAGE_SOURCES.map((s) => option(s, s, filter.source === s)).join("")}</select></label>
${textInput("project", "Project", filter.project)}
${textInput("client", "Client", filter.client)}
<label>Status<select name="status">${option("", "Any", !filter.status)}${USAGE_STATUSES.map((s) => option(s, s.replace("_", " "), filter.status === s)).join("")}</select></label>
${textInput("command", "Command", filter.command, "gemini image")}
<label>Search<input type="search" name="q" value="${escapeHtml(filter.q ?? "")}" maxlength="100" placeholder="command, model, error, id"></label>
<div class="row"><button class="btn small">Apply</button><a class="btn secondary small" href="${escapeHtml(path)}">Reset</a></div>
</form><p class="muted" style="margin:8px 0 0"><small>Dates are UTC. Choose “Custom” to use the from/to dates.</small></p></section>`;
}

export function eventTable(events: UsageEvent[]): string {
  if (events.length === 0) return `<p class="muted">No runs match these filters.</p>`;
  const rows = events
    .map((e) => {
      const model = e.modelResolved ?? e.modelRequested ?? "–";
      const where = [e.clientId, e.project].filter(Boolean).join(" · ") || "–";
      return `<tr><td><a href="/dashboard/traces/${encodeURIComponent(e.id)}">${escapeHtml(utcTime(e.startedAt))}</a></td><td class="wrap">${escapeHtml(e.command)}</td><td class="wrap">${escapeHtml(model)}</td><td>${escapeHtml(e.source)}</td><td class="wrap">${escapeHtml(where)}</td><td>${statusHtml(e.status)}${e.chargeState === "uncertain" ? ' <small class="unknown" title="May or may not be billed">uncertain</small>' : ""}</td><td class="num">${escapeHtml(durationText(e.durationMs))}</td><td class="num">${eventCostHtml(e)}</td></tr>`;
    })
    .join("");
  return `<div class="scroll"><table class="data"><thead><tr><th scope="col">Started (UTC)</th><th scope="col">Command</th><th scope="col">Model</th><th scope="col">Source</th><th scope="col">Client · project</th><th scope="col">Status</th><th scope="col" class="num">Duration</th><th scope="col" class="num">Cost</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** "Newest" and "Older" links that keep the current filter. */
export function pager(
  path: string,
  filter: UsageFilter,
  cursor: string | null,
  next: string | null,
): string {
  const links: string[] = [];
  const params = filterParams(filter);
  if (cursor)
    links.push(
      `<a class="btn secondary small" href="${escapeHtml(`${path}?${params}`)}">Newest</a>`,
    );
  if (next) {
    params.set("cursor", next);
    links.push(
      `<a class="btn secondary small" href="${escapeHtml(`${path}?${params}`)}" rel="next">Older</a>`,
    );
  }
  return links.length ? `<div class="pager">${links.join("")}</div>` : "";
}
