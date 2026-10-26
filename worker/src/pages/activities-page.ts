/**
 * Activities: the account's hash-chained audit log, newest first, with a
 * kind filter, search, date range, "Older" pages and a chain check.
 */

import { escapeHtml } from "../http-responses.js";
import type { Activity } from "../usage/usage-types.js";
import { type PageNotice, dashboardShell } from "./dashboard-nav.js";
import { count, isoDay, utcTime } from "./usage-format.js";

/** Kind prefixes offered in the filter (the log matches a prefix ending in `.`). */
export const ACTIVITY_KIND_PREFIXES: ReadonlyArray<[string, string]> = [
  ["auth.", "Sign-in and sign-out"],
  ["client.", "MCP clients"],
  ["provider_key.", "Provider keys"],
  ["api_key.", "API keys"],
  ["storage.", "Storage"],
  ["budget.", "Budgets"],
  ["usage.", "Usage imports, exports, adjustments"],
  ["rate_card.", "Rate card"],
  ["balances.", "Balances"],
  ["debug_capture.", "Debug capture"],
  ["debug_log.", "Debug log views"],
];

export interface ActivitiesQueryView {
  kind: string;
  q: string;
  from?: number;
  to?: number;
}

export interface ActivitiesView {
  query: ActivitiesQueryView;
  items: Activity[];
  next: number | null;
  /** Set when this page shows a page after the first. */
  before?: number;
  verify?: { ok: boolean; checked: number; brokenAtSeq: number | null };
  notice?: PageNotice;
}

function queryParams(q: ActivitiesQueryView): URLSearchParams {
  const params = new URLSearchParams();
  if (q.kind) params.set("kind", q.kind);
  if (q.q) params.set("q", q.q);
  if (q.from !== undefined) params.set("from", isoDay(q.from));
  if (q.to !== undefined) params.set("to", isoDay(q.to - 1));
  return params;
}

function metaHtml(meta: Activity["meta"]): string {
  const entries = Object.entries(meta);
  if (entries.length === 0) return "–";
  return entries
    .map(([k, v]) => `<span class="mono">${escapeHtml(k)}=${escapeHtml(String(v))}</span>`)
    .join(" ");
}

function verifyResult(v: ActivitiesView["verify"]): string {
  if (!v) return "";
  return v.ok
    ? `<p class="notice" role="status">Chain intact: ${count(v.checked)} entries checked, each one matches the hash of the entry before it.</p>`
    : `<p class="notice warn" role="status">Chain broken at entry #${escapeHtml(String(v.brokenAtSeq))} after ${count(v.checked)} good entries: an entry was changed or removed.</p>`;
}

export function activitiesPage(view: ActivitiesView): string {
  const { query } = view;
  const kinds = [["", "All kinds"] as [string, string], ...ACTIVITY_KIND_PREFIXES]
    .map(
      ([v, l]) =>
        `<option value="${escapeHtml(v)}"${v === query.kind ? " selected" : ""}>${escapeHtml(v ? `${l} (${v})` : l)}</option>`,
    )
    .join("");
  const rows = view.items
    .map(
      (a) =>
        `<tr><td class="num">${a.seq}</td><td>${escapeHtml(utcTime(a.ts))}</td><td class="mono">${escapeHtml(a.kind)}</td><td class="wrap"><small>${escapeHtml(a.actor)}</small></td><td class="wrap mono">${escapeHtml(a.target ?? "–")}</td><td class="wrap"><small>${metaHtml(a.meta)}</small></td></tr>`,
    )
    .join("");
  const table = rows
    ? `<div class="scroll"><table class="data"><thead><tr><th scope="col" class="num">#</th><th scope="col">When (UTC)</th><th scope="col">Kind</th><th scope="col">Actor</th><th scope="col">Target</th><th scope="col">Details</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="muted">No activities match.</p>`;
  const base = queryParams(query);
  const links: string[] = [];
  if (view.before !== undefined) {
    links.push(
      `<a class="btn secondary small" href="${escapeHtml(`/dashboard/activities?${base}`)}">Newest</a>`,
    );
  }
  if (view.next !== null) {
    const older = new URLSearchParams(base);
    older.set("before", String(view.next));
    links.push(
      `<a class="btn secondary small" href="${escapeHtml(`/dashboard/activities?${older}`)}" rel="next">Older</a>`,
    );
  }
  const verifyParams = new URLSearchParams(base);
  verifyParams.set("verify", "1");
  const body = `<h1>Activities</h1>
<p class="muted">Sign-ins, client connections, key, storage and budget changes, exports and debug-log views. Each entry carries a hash of the one before it, so a changed or removed entry shows up when the chain is checked. Key values and URLs are never recorded.</p>
${verifyResult(view.verify)}
<section class="card"><form method="get" action="/dashboard/activities" class="filters" aria-label="Filters">
<label>Kind<select name="kind">${kinds}</select></label>
<label>Search<input type="search" name="q" value="${escapeHtml(query.q)}" maxlength="100" placeholder="kind, actor, target"></label>
<label>From (UTC)<input type="date" name="from" value="${query.from === undefined ? "" : isoDay(query.from)}"></label>
<label>To (UTC, inclusive)<input type="date" name="to" value="${query.to === undefined ? "" : isoDay(query.to - 1)}"></label>
<div class="row"><button class="btn small">Apply</button><a class="btn secondary small" href="/dashboard/activities">Reset</a></div>
</form></section>
<section class="card"><div class="row" style="justify-content:space-between;margin-bottom:8px"><h2 style="margin:0">Log</h2><a class="btn secondary small" href="${escapeHtml(`/dashboard/activities?${verifyParams}`)}">Verify chain</a></div>
${table}${links.length ? `<div class="pager">${links.join("")}</div>` : ""}</section>`;
  return dashboardShell("Activities", "activities", body, view.notice);
}
