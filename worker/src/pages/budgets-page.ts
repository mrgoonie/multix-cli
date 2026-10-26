/**
 * Budgets: status of each budget, create/edit/delete forms, the account rate
 * card (estimates for runs without a provider-reported cost) and the
 * debug-capture switch. All writes are POST forms with the CSRF token.
 */

import { escapeHtml } from "../http-responses.js";
import {
  BUDGET_PERIODS,
  BUDGET_SCOPES,
  type Budget,
  type BudgetStatus,
  type RateCardEntry,
} from "../usage/usage-types.js";
import { type PageNotice, dashboardShell, hidden } from "./dashboard-nav.js";
import { budgetProgress } from "./overview-page.js";
import { count, isoDay, money, utcTime } from "./usage-format.js";

const DAY = 86_400_000;

/** Raw form values (strings), so a rejected form comes back as typed. */
export type BudgetFormValues = Partial<Record<(typeof BUDGET_FORM_FIELDS)[number], string>>;

export const BUDGET_FORM_FIELDS = [
  "name",
  "scope",
  "scope_value",
  "period",
  "window_start",
  "window_end",
  "limit_usd",
  "mode",
  "reserve_usd",
  "unknown_price",
  "thresholds",
] as const;

export interface BudgetsView {
  csrf: string;
  statuses: BudgetStatus[];
  rateCard: RateCardEntry[];
  /** Epoch ms until which stderr capture is on; 0 or past = off. */
  debugUntil: number;
  now: number;
  notice?: PageNotice;
  /** Values of a rejected create form, shown again. */
  draft?: BudgetFormValues;
  /** Rate card text of a rejected update, shown again. */
  rateCardDraft?: string;
}

export function budgetFormValues(b: Budget): BudgetFormValues {
  return {
    name: b.name,
    scope: b.scope,
    scope_value: b.scopeValue ?? "",
    period: b.period,
    window_start: b.windowStart === null ? "" : isoDay(b.windowStart),
    window_end: b.windowEnd === null ? "" : isoDay(b.windowEnd - DAY),
    limit_usd: String(b.limitUsd),
    mode: b.mode,
    reserve_usd: b.reserveUsd === null ? "" : String(b.reserveUsd),
    unknown_price: b.unknownPrice,
    thresholds: b.thresholds.join(", "),
  };
}

function select(
  name: string,
  label: string,
  options: readonly string[],
  value: string | undefined,
) {
  return `<label>${escapeHtml(label)}<select name="${name}">${options
    .map(
      (o) =>
        `<option value="${escapeHtml(o)}"${o === value ? " selected" : ""}>${escapeHtml(o)}</option>`,
    )
    .join("")}</select></label>`;
}

function input(
  name: string,
  label: string,
  type: string,
  value: string | undefined,
  extra = "",
): string {
  return `<label>${escapeHtml(label)}<input type="${type}" name="${name}" value="${escapeHtml(value ?? "")}" ${extra}></label>`;
}

function budgetFields(v: BudgetFormValues): string {
  return `<div class="form-grid">
${input("name", "Name", "text", v.name, 'required maxlength="80"')}
${select("scope", "Scope", BUDGET_SCOPES, v.scope ?? "account")}
${input("scope_value", "Scope value (not for account)", "text", v.scope_value, 'maxlength="128" placeholder="gemini, my-project, client id…" spellcheck="false"')}
${select("period", "Period (UTC)", BUDGET_PERIODS, v.period ?? "month")}
${input("window_start", "Custom start (UTC)", "date", v.window_start)}
${input("window_end", "Custom end (UTC, inclusive)", "date", v.window_end)}
${input("limit_usd", "Limit (USD)", "number", v.limit_usd, 'required min="0.01" max="1000000" step="0.01"')}
${select("mode", "Mode", ["alert", "block"], v.mode ?? "alert")}
${input("reserve_usd", "Reserve per job (USD, optional)", "number", v.reserve_usd, 'min="0" max="10000" step="any"')}
${select("unknown_price", "Job with unknown price", ["allow", "block"], v.unknown_price ?? "allow")}
${input("thresholds", "Alert thresholds (%)", "text", v.thresholds ?? "50, 80, 100", 'maxlength="40"')}
</div>`;
}

function statusDetail(s: BudgetStatus): string {
  const crossed = s.crossed.length ? s.crossed.map((t) => `${t}%`).join(", ") : "none";
  return `<p class="muted"><small>Window ${escapeHtml(utcTime(s.window.start))} – ${escapeHtml(utcTime(s.window.end))} UTC · reported ${escapeHtml(money(s.actualUsd))} · estimated ${escapeHtml(money(s.estimatedUsd))} · held ${escapeHtml(money(s.heldUsd))} · thresholds crossed: ${escapeHtml(crossed)} · unknown price: ${escapeHtml(s.budget.unknownPrice)}${
    s.budget.reserveUsd !== null ? ` · reserve ${escapeHtml(money(s.budget.reserveUsd))}/job` : ""
  }</small></p>`;
}

function budgetItem(s: BudgetStatus, csrf: string): string {
  const id = s.budget.id;
  return `<div class="budget-item">${budgetProgress(s)}${statusDetail(s)}
<details><summary>Edit or delete</summary>
<form method="post" action="/dashboard/budgets" style="margin-top:10px">${hidden("csrf", csrf)}${hidden("id", id)}${hidden("intent", "update")}${budgetFields(budgetFormValues(s.budget))}<button class="btn small">Save budget</button></form>
<form method="post" action="/dashboard/budgets" style="margin-top:8px">${hidden("csrf", csrf)}${hidden("id", id)}${hidden("intent", "delete")}<button class="btn danger small">Delete budget</button></form>
</details></div>`;
}

function rateCardCard(view: BudgetsView): string {
  const rows = view.rateCard
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.provider)}</td><td>${escapeHtml(r.model)}</td><td>${escapeHtml(r.unit)}</td><td class="num">${escapeHtml(money(r.usd))}</td><td>${escapeHtml(r.effectiveFrom)}</td><td class="wrap">${escapeHtml(r.version)}</td></tr>`,
    )
    .join("");
  const table = rows
    ? `<div class="scroll"><table class="data"><thead><tr><th scope="col">Provider</th><th scope="col">Model</th><th scope="col">Unit</th><th scope="col" class="num">USD</th><th scope="col">From</th><th scope="col">Version</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="muted">No prices yet: runs without a provider-reported cost show as unknown.</p>`;
  const json =
    view.rateCardDraft ??
    JSON.stringify(
      view.rateCard.map((r) => ({
        provider: r.provider,
        model: r.model,
        unit: r.unit,
        usd: r.usd,
        effective_from: r.effectiveFrom,
        version: r.version,
      })),
      null,
      2,
    );
  return `<section class="card"><h2>Rate card</h2>
<p class="muted"><small>Your own prices, used to estimate runs whose provider reports no cost. Estimates are marked “est.” everywhere. Units: job, output, output_second, 1k_input_tokens, 1k_output_tokens, credit. Model <span class="mono">*</span> matches every model of the provider.</small></p>
${table}
<form method="post" action="/dashboard/rate-card" style="margin-top:12px">${hidden("csrf", view.csrf)}
<label class="muted" for="rate-card-json"><small>Replace the whole rate card (JSON array)</small></label>
<textarea id="rate-card-json" name="entries" spellcheck="false" placeholder='[{"provider":"gemini","model":"*","unit":"output","usd":0.04,"effective_from":"2026-01-01","version":"pricing page 2026-01"}]'>${escapeHtml(json)}</textarea>
<p style="margin-top:8px"><button class="btn small">Save rate card</button></p></form></section>`;
}

function debugCaptureCard(view: BudgetsView): string {
  const on = view.debugUntil > view.now;
  const state = on
    ? `<span class="badge ok">on</span> until ${escapeHtml(utcTime(view.debugUntil))} UTC`
    : `<span class="badge off">off</span>`;
  return `<section class="card"><h2>Debug capture</h2>
<p>${state}</p>
<p class="muted"><small>While on, Multix keeps the last part of stderr of each remote job so failed runs can be investigated from Traces. The text is redacted (keys and URLs removed) before it is stored, each log is kept 7 days, capture turns itself off after 7 days, and every view of a log is recorded in Activities. Turning it off deletes the logs already kept.</small></p>
<form method="post" action="/dashboard/debug-capture">${hidden("csrf", view.csrf)}${hidden("enabled", on ? "0" : "1")}<button class="btn ${on ? "danger" : "secondary"} small">${on ? "Turn off and delete logs" : "Turn on for 7 days"}</button></form></section>`;
}

export function budgetsPage(view: BudgetsView): string {
  const list = view.statuses.length
    ? view.statuses.map((s) => budgetItem(s, view.csrf)).join("")
    : `<p class="muted">No budgets yet.</p>`;
  const body = `<h1>Budgets</h1>
<p class="notice warn">Blocking budgets only stop jobs Multix starts (MCP and REST). They cannot stop spend made directly with a provider or by local CLI runs.</p>
<section class="card"><h2>Your budgets (${count(view.statuses.length)})</h2>
<p class="muted"><small>Committed = reported + estimated + held for running or uncertain jobs. The forecast is a linear projection to the end of the window, not a bill.</small></p>
${list}</section>
<section class="card"><h2>Create a budget</h2>
<form method="post" action="/dashboard/budgets">${hidden("csrf", view.csrf)}${hidden("intent", "create")}${budgetFields(view.draft ?? {})}
<p class="muted"><small>Alert mode only reports. Block mode also refuses new Multix jobs that would go over the limit; with “Job with unknown price: block”, it also refuses jobs it cannot price. Custom dates are needed only for the custom period.</small></p>
<button class="btn small">Create budget</button></form></section>
${rateCardCard(view)}
${debugCaptureCard(view)}`;
  return dashboardShell("Budgets", "budgets", body, view.notice);
}
