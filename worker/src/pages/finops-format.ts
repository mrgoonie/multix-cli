/**
 * Formatting and small building blocks shared by the dashboard's usage pages
 * (overview, usage & costs, budgets, traces, activity) and the tab bar shown
 * on every dashboard page. Every helper returns escaped HTML.
 *
 * Unknown is never zero: a null number renders as "unknown" (measurements,
 * costs) or "—" (identifiers that do not apply).
 */

import { escapeHtml } from "../http-responses.js";
import type { CostProvenance, UsageTotals } from "../ledger/ledger-types.js";
import { formatDate, page } from "./page-layout.js";

export type DashboardTab = "account" | "overview" | "usage" | "budgets" | "traces" | "activity";

const TABS: ReadonlyArray<{ id: DashboardTab; href: string; label: string }> = [
  { id: "account", href: "/dashboard", label: "Account" },
  { id: "overview", href: "/dashboard/overview", label: "Overview" },
  { id: "usage", href: "/dashboard/usage", label: "Usage &amp; costs" },
  { id: "budgets", href: "/dashboard/budgets", label: "Budgets" },
  { id: "traces", href: "/dashboard/traces", label: "Traces" },
  { id: "activity", href: "/dashboard/activity", label: "Activity" },
];

/** The dashboard tab bar; only rendered when the usage ledger is configured. */
export function dashboardTabs(active: DashboardTab): string {
  const links = TABS.map(
    (t) => `<a href="${t.href}"${t.id === active ? ' aria-current="page"' : ""}>${t.label}</a>`,
  ).join("");
  return `<nav class="tabs" aria-label="Dashboard sections">${links}</nav>`;
}

export const UNKNOWN = '<span class="muted">unknown</span>';
export const NONE = '<span class="muted">—</span>';

/** Plain, escaped text, or "—" when absent. */
export function textOr(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? NONE : escapeHtml(value);
}

/** Fixed decimals with trailing zeros dropped, keeping at least two. */
function fixedTrimmed(value: number, decimals: number): string {
  const [whole, fraction = ""] = value.toFixed(decimals).split(".");
  return `${whole}.${fraction.replace(/0+$/, "").padEnd(2, "0")}`;
}

/** The dollar amount as text: 1234.5 → "$1,234.50", 0.012345 → "$0.0123", 0.000042 → "$0.000042". */
export function usdText(value: number): string {
  const abs = Math.abs(value);
  const digits =
    abs >= 1
      ? abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : fixedTrimmed(abs, abs >= 0.01 ? 4 : 6);
  return `${value < 0 && digits !== "0.00" ? "-" : ""}$${digits}`;
}

/** Money with the exact (6-decimal) amount in the tooltip; null renders as "unknown". */
export function money(value: number | null | undefined, suffix = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return UNKNOWN;
  const exact = `${Number(value.toFixed(6))} USD`;
  return `<span title="${escapeHtml(exact)}">${escapeHtml(usdText(value))}${suffix ? " USD" : ""}</span>`;
}

/**
 * Known cost of a set of operations: "unknown" when every operation's cost is
 * unknown (a sum of nothing is not $0), with the unknown count beside it otherwise.
 */
export function knownCost(t: UsageTotals, suffix = false): string {
  if (t.operations > 0 && t.unknown_cost_operations === t.operations && t.adjustments_usd === 0) {
    return UNKNOWN;
  }
  const unknown =
    t.unknown_cost_operations > 0
      ? ` <small class="muted">+ ${count(t.unknown_cost_operations)} unknown</small>`
      : "";
  return `${money(t.known_cost_usd, suffix)}${unknown}`;
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return UNKNOWN;
  return escapeHtml(value.toLocaleString("en-US", { maximumFractionDigits: 4 }));
}

/** A 0..1 ratio as a percentage. */
export function ratio(value: number | null | undefined): string {
  if (value === null || value === undefined) return UNKNOWN;
  return `${escapeHtml((value * 100).toFixed(1).replace(/\.0$/, ""))}%`;
}

/** A 0..100 percentage. */
export function percent(value: number): string {
  return `${escapeHtml(value.toFixed(1).replace(/\.0$/, ""))}%`;
}

export function durationText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return UNKNOWN;
  return escapeHtml(durationText(ms));
}

export function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return UNKNOWN;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit++;
  }
  return escapeHtml(unit === 0 ? `${n} B` : `${n.toFixed(n < 10 ? 1 : 0)} ${units[unit]}`);
}

export function date(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return UNKNOWN;
  return escapeHtml(formatDate(ms));
}

/** YYYY-MM-DD (UTC) for date inputs. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const PROVENANCE_LABELS: Record<CostProvenance, string> = {
  provider_reported: "provider reported",
  estimated: "estimated",
  billed: "billed",
  unknown: "unknown",
};

export function provenance(value: CostProvenance): string {
  const label = Object.hasOwn(PROVENANCE_LABELS, value) ? PROVENANCE_LABELS[value] : value;
  return `<span class="badge${value === "unknown" ? "" : " ok"}">${escapeHtml(label)}</span>`;
}

export function statusLabel(status: string): string {
  const cls = status === "succeeded" ? "ok" : status === "running" ? "" : "failed";
  return `<span class="state ${cls}">${escapeHtml(status.replace("_", " "))}</span>`;
}

/** A horizontally scrollable table: the table scrolls, not the page. */
export function dataTable(head: string[], rows: string[][], numeric: number[] = []): string {
  const th = head
    .map((h, i) => `<th scope="col"${numeric.includes(i) ? ' class="num"' : ""}>${h}</th>`)
    .join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${r.map((cell, i) => `<td${numeric.includes(i) ? ' class="num"' : ""}>${cell}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table class="data"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function noticeHtml(notice?: { text: string; warn?: boolean }): string {
  return notice
    ? `<p class="notice${notice.warn ? " warn" : ""}" role="status">${escapeHtml(notice.text)}</p>`
    : "";
}

export function hiddenCsrf(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
}

/** `<option>`s with the current value selected; the empty value means "any". */
export function options(values: readonly string[], current: string, anyLabel?: string): string {
  const any =
    anyLabel === undefined
      ? ""
      : `<option value=""${current === "" ? " selected" : ""}>${escapeHtml(anyLabel)}</option>`;
  return (
    any +
    values
      .map(
        (v) =>
          `<option value="${escapeHtml(v)}"${v === current ? " selected" : ""}>${escapeHtml(v)}</option>`,
      )
      .join("")
  );
}

/** Metadata of an activity as escaped `key=value` pairs. */
export function metadataText(metadata: Record<string, unknown>): string {
  const entries = Object.entries(metadata ?? {});
  if (entries.length === 0) return NONE;
  return entries
    .map(([k, v]) => `<code>${escapeHtml(k)}=${escapeHtml(v === null ? "null" : String(v))}</code>`)
    .join(" ");
}

export function traceLink(opId: string, label = opId): string {
  return `<a href="/dashboard/traces/${encodeURIComponent(opId)}" class="mono">${escapeHtml(label)}</a>`;
}

/** A wide dashboard page with the tab bar. */
export function finopsPage(title: string, active: DashboardTab, body: string): string {
  return page(title, `${dashboardTabs(active)}${body}`, { wide: true });
}
