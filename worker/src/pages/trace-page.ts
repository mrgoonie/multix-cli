/**
 * One run's trace: span waterfall, every recorded fact, adjustments (with a
 * form to add one) and, when captured, the redacted stderr tail behind a
 * POST (reading it is logged).
 */

import { escapeHtml } from "../http-responses.js";
import type { EventDetail } from "../usage/usage-service.js";
import type { UsageEvent, UsageSpan } from "../usage/usage-types.js";
import { type PageNotice, dashboardShell, hidden } from "./dashboard-nav.js";
import { spanWaterfall } from "./svg-charts.js";
import {
  EST_HTML,
  bytesText,
  count,
  durationText,
  eventCostHtml,
  money,
  statusHtml,
  utcTime,
} from "./usage-format.js";

export interface TraceView {
  csrf: string;
  detail: EventDetail;
  /** Set on the response to "Show debug log" only. */
  debugLog?: string | null;
  notice?: PageNotice;
}

function fact(label: string, valueHtml: string): string {
  return `<dt>${escapeHtml(label)}</dt><dd>${valueHtml}</dd>`;
}

const text = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === "" ? "–" : escapeHtml(String(v));

function spansOf(e: UsageEvent): UsageSpan[] {
  if (e.spans.length > 0) return e.spans;
  if (e.finishedAt !== null) return [{ name: "run", start: e.startedAt, end: e.finishedAt }];
  return [];
}

function costFacts(e: UsageEvent): string {
  const reported = e.actualCostUsd === null ? "–" : escapeHtml(money(e.actualCostUsd));
  const estimated =
    e.estimatedCostUsd === null ? "–" : `${escapeHtml(money(e.estimatedCostUsd))}${EST_HTML}`;
  const rate = [e.rateSource, e.rateVersion, e.rateEffective ? `from ${e.rateEffective}` : null]
    .filter(Boolean)
    .join(" · ");
  return [
    fact("Cost", eventCostHtml(e)),
    fact("Provider-reported / billed", reported),
    fact("Estimated", estimated),
    fact("Adjustments", e.adjustmentUsd === 0 ? "–" : escapeHtml(money(e.adjustmentUsd))),
    fact("Provenance", text(e.provenance.replace("_", " "))),
    fact("Rate card", text(rate)),
    fact(
      "Charge state",
      e.chargeState === "uncertain"
        ? `<span class="unknown">uncertain</span> <small class="muted">(may or may not be billed)</small>`
        : text(e.chargeState.replace("_", " ")),
    ),
  ].join("");
}

function usageFacts(e: UsageEvent): string {
  const tokens =
    e.tokensTotal === null && e.tokensInput === null && e.tokensOutput === null
      ? "–"
      : `${count(e.tokensInput)} in · ${count(e.tokensOutput)} out${e.tokensThinking !== null ? ` · ${count(e.tokensThinking)} thinking` : ""}${e.tokensTotal !== null ? ` · ${count(e.tokensTotal)} total` : ""}`;
  const credits =
    e.credits === null
      ? "–"
      : `${count(e.credits)}${e.creditsUnit ? ` ${escapeHtml(e.creditsUnit)}` : ""}`;
  const http =
    e.httpRequests === null
      ? "–"
      : `${count(e.httpRequests)} requests · ${count(e.httpErrors)} errors · ${escapeHtml(durationText(e.httpMs))}`;
  const metrics = Object.entries(e.metrics)
    .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(String(v))}`)
    .join(", ");
  return [
    fact("Tokens", tokens),
    fact("Characters", count(e.characters)),
    fact("Audio seconds", count(e.audioSeconds)),
    fact("Credits", credits),
    fact("HTTP", http),
    fact("Metrics", metrics || "–"),
  ].join("");
}

function outputsTable(e: UsageEvent): string {
  if (e.outputs.length === 0) return `<p class="muted">No outputs recorded.</p>`;
  const rows = e.outputs
    .map(
      (o) =>
        `<tr><td class="wrap">${escapeHtml(o.name)}</td><td>${text(o.mime)}</td><td class="num">${escapeHtml(bytesText(o.bytes))}</td><td class="num">${o.durationS === undefined ? "–" : escapeHtml(`${o.durationS} s`)}</td><td>${o.stored === undefined ? "–" : o.stored ? "yes" : "no"}</td><td class="mono wrap">${text(o.sha256)}</td></tr>`,
    )
    .join("");
  return `<div class="scroll"><table class="data"><thead><tr><th scope="col">Name</th><th scope="col">MIME</th><th scope="col" class="num">Size</th><th scope="col" class="num">Length</th><th scope="col">Stored</th><th scope="col">SHA-256</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function adjustmentsCard(view: TraceView): string {
  const { event, adjustments } = view.detail;
  const rows = adjustments
    .map(
      (a) =>
        `<tr><td>${escapeHtml(utcTime(a.createdAt))}</td><td>${escapeHtml(a.kind)}</td><td class="num">${escapeHtml(money(a.amountUsd))}</td><td class="wrap">${escapeHtml(a.reason)}</td><td class="wrap"><small class="muted">${escapeHtml(a.actor)}</small></td></tr>`,
    )
    .join("");
  const list = rows
    ? `<div class="scroll"><table class="data"><thead><tr><th scope="col">When (UTC)</th><th scope="col">Kind</th><th scope="col" class="num">Amount</th><th scope="col">Reason</th><th scope="col">By</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="muted">No adjustments.</p>`;
  return `<section class="card"><h2>Adjustments</h2>${list}
<form method="post" action="/dashboard/traces/${encodeURIComponent(event.id)}/adjustments" style="margin-top:12px">${hidden("csrf", view.csrf)}
<div class="form-grid">
<label>Kind<select name="kind"><option value="refund">Refund (lowers the cost)</option><option value="correction">Correction (+ or −)</option><option value="billed">Billed amount (replaces the cost)</option></select></label>
<label>Amount (USD)<input type="number" name="amount_usd" step="any" required></label>
<label>Reason<input type="text" name="reason" required maxlength="200" placeholder="Invoice 2026-10, refund for failed run"></label>
</div><button class="btn small">Add adjustment</button></form></section>`;
}

function debugCard(view: TraceView): string {
  const { event, hasDebugLog } = view.detail;
  if (view.debugLog !== undefined) {
    const log =
      view.debugLog === null
        ? `<p class="muted">The debug log is no longer available (it expired or capture was turned off).</p>`
        : `<pre>${escapeHtml(view.debugLog)}</pre>`;
    return `<section class="card"><h2>Debug log</h2><p class="muted"><small>Redacted stderr tail. This view was recorded in Activities.</small></p>${log}</section>`;
  }
  if (!hasDebugLog) return "";
  return `<section class="card"><h2>Debug log</h2><p class="muted"><small>A redacted stderr tail was captured for this run (kept 7 days). Opening it is recorded in Activities.</small></p>
<form method="post" action="/dashboard/traces/${encodeURIComponent(event.id)}/debug-log">${hidden("csrf", view.csrf)}<button class="btn secondary small">Show debug log</button></form></section>`;
}

export function tracePage(view: TraceView): string {
  const e = view.detail.event;
  const model =
    e.modelResolved && e.modelRequested && e.modelResolved !== e.modelRequested
      ? `${escapeHtml(e.modelRequested)} → ${escapeHtml(e.modelResolved)}`
      : text(e.modelResolved ?? e.modelRequested);
  const run = [
    fact("Status", statusHtml(e.status)),
    fact(
      "Error",
      e.errorCode || e.errorReason
        ? `${text(e.errorCode)}${e.errorReason ? ` <small class="muted">${escapeHtml(e.errorReason)}</small>` : ""}`
        : "–",
    ),
    fact("Command", `<span class="mono">${escapeHtml(e.command)}</span>`),
    fact("Provider", text(e.provider)),
    fact("Model (requested → resolved)", model),
    fact("Source", text(e.source)),
    fact("Client", text(e.clientId)),
    fact("Project", text(e.project)),
    fact("Started (UTC)", text(utcTime(e.startedAt))),
    fact("Running (UTC)", text(utcTime(e.runningAt))),
    fact("Finished (UTC)", text(utcTime(e.finishedAt))),
    fact("Duration", text(durationText(e.durationMs))),
    fact("Attempt", text(e.attempt)),
    fact("Event id", `<span class="mono">${escapeHtml(e.id)}</span>`),
    fact("Trace id", `<span class="mono">${escapeHtml(e.traceId)}</span>`),
    fact("Job id", e.jobId ? `<span class="mono">${escapeHtml(e.jobId)}</span>` : "–"),
    fact("History id", e.historyId ? `<span class="mono">${escapeHtml(e.historyId)}</span>` : "–"),
    fact(
      "Provider ids",
      e.providerIds.length
        ? `<span class="mono">${e.providerIds.map(escapeHtml).join(", ")}</span>`
        : "–",
    ),
    fact("Outputs", `${count(e.outputCount)} · ${escapeHtml(bytesText(e.outputBytes))}`),
  ].join("");
  const body = `<p><a href="/dashboard/traces">← All traces</a></p>
<h1 class="mono">${escapeHtml(e.command)}</h1>
<p class="muted">${statusHtml(e.status)} · ${escapeHtml(utcTime(e.startedAt))} UTC · cost ${eventCostHtml(e)}</p>
<section class="card"><h2>Timeline</h2>${spanWaterfall(spansOf(e), `Timeline of run ${e.id}`)}</section>
<div class="grid2">
<section class="card"><h2>Run</h2><dl class="facts">${run}</dl></section>
<section class="card"><h2>Cost</h2><dl class="facts">${costFacts(e)}</dl><h2 style="margin-top:16px">Usage</h2><dl class="facts">${usageFacts(e)}</dl></section>
</div>
<section class="card" style="margin-top:16px"><h2>Outputs</h2>${outputsTable(e)}</section>
${adjustmentsCard(view)}
${debugCard(view)}`;
  return dashboardShell(`Trace ${e.id}`, "traces", body, view.notice);
}
