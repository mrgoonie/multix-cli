/**
 * Traces: the account's operations newest first (cursor pages, filters for
 * status, provider and source) and one operation's detail with a waterfall
 * of its recorded spans, every measured field, outputs, provider ids,
 * metrics, adjustments and where its cost comes from.
 */

import { escapeHtml } from "../http-responses.js";
import {
  type Adjustment,
  OPERATION_SOURCES,
  OPERATION_STATUSES,
  type Operation,
} from "../ledger/ledger-types.js";
import {
  NONE,
  UNKNOWN,
  bytes,
  count,
  dataTable,
  date,
  duration,
  durationText,
  finopsPage,
  money,
  noticeHtml,
  options,
  provenance,
  statusLabel,
  textOr,
  traceLink,
} from "./finops-format.js";

export interface TraceFilterValues {
  status: string;
  provider: string;
  source: string;
}

export interface TracesView {
  form: TraceFilterValues;
  operations: Operation[];
  /** Query string for the next (older) page, or null on the last page. */
  olderQuery: string | null;
  /** True when this is not the first page. */
  paged: boolean;
  error?: string;
}

/** Known cost of one operation: the provider's figure first, else the estimate. */
function opCost(op: Operation): string {
  return money(op.actual_cost_usd ?? op.estimated_cost_usd);
}

export function tracesPage(view: TracesView): string {
  const f = view.form;
  const form = `<form method="get" action="/dashboard/traces" class="filters">
<label>Status<select name="status">${options(OPERATION_STATUSES, f.status, "any")}</select></label>
<label>Provider<input type="text" name="provider" maxlength="200" value="${escapeHtml(f.provider)}"></label>
<label>Source<select name="source">${options(OPERATION_SOURCES, f.source, "any")}</select></label>
<button class="btn small">Apply</button><a class="btn secondary small" href="/dashboard/traces">Reset</a></form>`;
  const rows = view.operations.map((op) => [
    date(op.started_at),
    traceLink(op.op_id),
    escapeHtml(op.provider),
    textOr(op.model),
    escapeHtml(op.command),
    escapeHtml(op.source),
    statusLabel(op.status),
    duration(op.duration_ms),
    opCost(op),
    provenance(op.cost_provenance),
  ]);
  const table = rows.length
    ? dataTable(
        [
          "Started",
          "Operation",
          "Provider",
          "Model",
          "Command",
          "Source",
          "Status",
          "Duration",
          "Cost (USD)",
          "Cost source",
        ],
        rows,
        [7, 8],
      )
    : '<p class="muted">No operations match.</p>';
  const pager = `<div class="pager"><span>${view.paged ? '<a href="/dashboard/traces">Newest</a>' : ""}</span><span>${view.olderQuery ? `<a href="/dashboard/traces?${escapeHtml(view.olderQuery)}">Older operations</a>` : ""}</span></div>`;
  return finopsPage(
    "Traces",
    "traces",
    `<section class="card"><h1>Traces</h1>${form}${view.error ? noticeHtml({ text: view.error, warn: true }) : ""}${table}${pager}</section>`,
  );
}

/** Waterfall of the recorded spans as CSS bars, offsets relative to the first span. */
function waterfall(op: Operation): string {
  const spans = (op.detail?.spans ?? []).filter(
    (s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start,
  );
  if (spans.length === 0) return '<p class="muted">No spans were recorded for this operation.</p>';
  const start = Math.min(...spans.map((s) => s.start));
  const total = Math.max(1, Math.max(...spans.map((s) => s.end)) - start);
  const rows = spans
    .map((s) => {
      const left = (((s.start - start) / total) * 100).toFixed(2);
      const width = (((s.end - s.start) / total) * 100).toFixed(2);
      const label = `${s.name}: ${durationText(s.end - s.start)}, starts at +${durationText(s.start - start)}`;
      return `<div class="wf-row" title="${escapeHtml(label)}"><span class="mono">${escapeHtml(s.name)}</span><div class="wf-track" role="img" aria-label="${escapeHtml(label)}"><div class="wf-bar" style="left:${left}%;width:${width}%"></div></div><span class="mono">${escapeHtml(durationText(s.end - s.start))}</span></div>`;
    })
    .join("");
  return `${rows}<p class="muted"><small>Total ${escapeHtml(durationText(total))} from the first span's start.</small></p>`;
}

function field(label: string, value: string): string {
  return `<dt>${label}</dt><dd>${value}</dd>`;
}

function tokens(op: Operation): string {
  const parts = [
    `input ${count(op.tokens_input)}`,
    `output ${count(op.tokens_output)}`,
    `total ${count(op.tokens_total)}`,
  ];
  if (op.tokens_thinking !== null) parts.push(`thinking ${count(op.tokens_thinking)}`);
  return parts.join(", ");
}

export function traceDetailPage(op: Operation, adjustments: Adjustment[]): string {
  const detail = op.detail ?? {};
  const client = op.client_name
    ? `${escapeHtml(op.client_name)}${op.client_id ? ` <small class="muted mono">${escapeHtml(op.client_id)}</small>` : ""}`
    : textOr(op.client_id);
  const fields = `<dl class="fields-list">
${field("Operation id", `<span class="mono">${escapeHtml(op.op_id)}</span>`)}
${field("Trace id", `<span class="mono">${escapeHtml(op.trace_id)}</span>`)}
${field("Job id", textOr(op.job_id))}
${field("CLI history id", textOr(op.history_id))}
${field("Status", statusLabel(op.status))}
${field("Error code", textOr(op.error_code))}
${field("Error", textOr(detail.error))}
${field("Source", escapeHtml(op.source))}
${field("Client", client)}
${field("Project", textOr(op.project_id))}
${field("Command", escapeHtml(op.command))}
${field("Provider", escapeHtml(op.provider))}
${field("Model", textOr(op.model))}
${field("Task", textOr(op.task))}
${field("Started", date(op.started_at))}
${field("Finished", op.finished_at === null ? (op.status === "running" ? NONE : UNKNOWN) : date(op.finished_at))}
${field("Duration", duration(op.duration_ms))}
${field("Outputs", `${count(op.output_count)} (${bytes(op.output_bytes)})`)}
${field("Tokens", tokens(op))}
${field("Credits", op.credits === null ? UNKNOWN : `${count(op.credits)} ${textOr(op.credits_unit)}`)}
${field("Provider-reported cost", money(op.actual_cost_usd, true))}
${field("Estimated cost", money(op.estimated_cost_usd, true))}
${field("Cost source", provenance(op.cost_provenance))}
${field("Rate source", textOr(op.rate_source))}
${field("HTTP requests", `${count(op.http_requests)} (errors: ${count(op.http_errors)})`)}
${field("CLI version", textOr(detail.cli_version))}
</dl>`;
  const outputs = detail.outputs?.length
    ? dataTable(
        ["#", "Name", "Size", "Type", "SHA-256", "Media duration"],
        detail.outputs.map((o, i) => [
          String(i + 1),
          textOr(o.name),
          bytes(o.bytes),
          textOr(o.mime),
          o.sha256
            ? `<span class="mono" title="${escapeHtml(o.sha256)}">${escapeHtml(o.sha256.slice(0, 12))}…</span>`
            : NONE,
          o.duration_s === undefined ? NONE : escapeHtml(`${o.duration_s} s`),
        ]),
        [2],
      )
    : '<p class="muted">No outputs recorded.</p>';
  const providerIds = detail.provider_ids?.length
    ? `<ul>${detail.provider_ids.map((id) => `<li class="mono">${escapeHtml(id)}</li>`).join("")}</ul>`
    : '<p class="muted">None recorded.</p>';
  const metrics = Object.entries(detail.metrics ?? {});
  const metricsTable = metrics.length
    ? dataTable(
        ["Metric", "Value"],
        metrics.map(([k, v]) => [`<span class="mono">${escapeHtml(k)}</span>`, count(v)]),
        [1],
      )
    : '<p class="muted">None recorded.</p>';
  const adjustmentsTable = adjustments.length
    ? dataTable(
        ["Time", "Kind", "Amount (USD)", "Note", "By"],
        adjustments.map((a) => [
          date(a.created_at),
          escapeHtml(a.kind),
          money(a.amount_usd),
          textOr(a.note),
          escapeHtml(a.actor),
        ]),
        [2],
      )
    : '<p class="muted">No adjustments.</p>';
  return finopsPage(
    `Trace ${op.op_id}`,
    "traces",
    `<p><a href="/dashboard/traces">← All traces</a></p>
<section class="card"><h1 class="mono" style="overflow-wrap:anywhere">${escapeHtml(op.op_id)}</h1>
<p>${statusLabel(op.status)} · ${escapeHtml(op.provider)} · ${escapeHtml(op.command)} · cost ${money(op.actual_cost_usd ?? op.estimated_cost_usd, true)} ${provenance(op.cost_provenance)}</p></section>
<section class="card"><h2>Timeline</h2>${waterfall(op)}</section>
<section class="card"><h2>Measured fields</h2>${fields}</section>
<section class="card"><h2>Outputs</h2>${outputs}</section>
<section class="card"><h2>Provider ids</h2>${providerIds}</section>
<section class="card"><h2>Metrics</h2>${metricsTable}</section>
<section class="card"><h2>Adjustments</h2>${adjustmentsTable}</section>`,
  );
}
