/**
 * Activity log: search, kind prefix and date filters, "older" cursor paging,
 * and the result of re-checking the log's hash chain.
 */

import { escapeHtml } from "../http-responses.js";
import type { Activity } from "../ledger/ledger-types.js";
import {
  count,
  dataTable,
  date,
  finopsPage,
  metadataText,
  noticeHtml,
  textOr,
} from "./finops-format.js";

export interface ActivityFilterValues {
  q: string;
  kind: string;
  from: string;
  to: string;
}

export interface ActivityView {
  form: ActivityFilterValues;
  activities: Activity[];
  integrity: { ok: boolean; checked: number; first_bad_seq: number | null };
  /** Query string for the next (older) page, or null on the last page. */
  olderQuery: string | null;
  paged: boolean;
  error?: string;
}

function integrityLine(integrity: ActivityView["integrity"]): string {
  if (integrity.ok) {
    return `<p class="notice" role="status">Integrity check passed: ${count(integrity.checked)} entries re-hashed, the chain is intact.</p>`;
  }
  return `<p class="notice warn" role="alert">Integrity check failed at entry #${escapeHtml(String(integrity.first_bad_seq))} (after ${count(integrity.checked)} intact entries): the log was changed outside the ledger.</p>`;
}

export function activityPage(view: ActivityView): string {
  const f = view.form;
  const form = `<form method="get" action="/dashboard/activity" class="filters">
<label>Search<input type="text" name="q" maxlength="100" value="${escapeHtml(f.q)}" placeholder="kind, actor, subject…"></label>
<label>Kind starts with<input type="text" name="kind" maxlength="64" value="${escapeHtml(f.kind)}" placeholder="e.g. budget."></label>
<label>From (UTC)<input type="date" name="from" value="${escapeHtml(f.from)}"></label>
<label>To (UTC, inclusive)<input type="date" name="to" value="${escapeHtml(f.to)}"></label>
<button class="btn small">Apply</button><a class="btn secondary small" href="/dashboard/activity">Reset</a></form>`;
  const table = view.activities.length
    ? dataTable(
        ["#", "Time", "Kind", "Actor", "Subject", "Details"],
        view.activities.map((a) => [
          escapeHtml(String(a.seq)),
          date(a.ts),
          `<code>${escapeHtml(a.kind)}</code>`,
          escapeHtml(a.actor),
          textOr(a.subject),
          metadataText(a.metadata),
        ]),
        [0],
      )
    : '<p class="muted">No activity matches.</p>';
  const pager = `<div class="pager"><span>${view.paged ? '<a href="/dashboard/activity">Newest</a>' : ""}</span><span>${view.olderQuery ? `<a href="/dashboard/activity?${escapeHtml(view.olderQuery)}">Older entries</a>` : ""}</span></div>`;
  return finopsPage(
    "Activity",
    "activity",
    `<section class="card"><h1>Activity</h1>
<p class="muted">Sign-ins, key and storage changes, jobs, budget alerts and exports of this account. Key values, prompts and URLs are never recorded.</p>
${integrityLine(view.integrity)}${form}${view.error ? noticeHtml({ text: view.error, warn: true }) : ""}${table}${pager}</section>`,
  );
}
