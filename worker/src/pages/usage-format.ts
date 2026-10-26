/**
 * Formatting shared by the usage dashboard pages. Every helper returns HTML
 * that is already escaped (or plain text safe to embed). A cost nobody
 * measured is shown as "unknown", never as $0; estimates are marked "est.".
 */

import { escapeHtml } from "../http-responses.js";
import type { UsageEvent } from "../usage/usage-types.js";

/**
 * USD with enough decimals to be meaningful: two at $1 and above, at least
 * four below (`$0.0400`), more for tiny amounts (`$0.00012`).
 */
export function money(usd: number): string {
  if (!Number.isFinite(usd)) return "unknown";
  const abs = Math.abs(usd);
  const sign = usd < 0 ? "-" : "";
  if (abs === 0) return "$0.00";
  if (abs >= 1) {
    return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  const decimals = Math.min(8, Math.max(4, Math.ceil(-Math.log10(abs)) + 1));
  return `${sign}$${abs.toFixed(decimals)}`;
}

export function count(n: number | null | undefined): string {
  return n === null || n === undefined ? "–" : n.toLocaleString("en-US");
}

export function durationText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} m ${String(seconds).padStart(2, "0")} s`;
}

export function bytesText(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function percentText(n: number | null | undefined): string {
  return n === null || n === undefined ? "–" : `${n}%`;
}

/** Minute-precision UTC time, as on the rest of the dashboard. */
export function utcTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}`;
}

/** YYYY-MM-DD (UTC) for date inputs. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export const UNKNOWN_HTML = `<span class="unknown" title="The run may have cost money but no price is known">unknown</span>`;
export const EST_HTML = ` <span class="est" title="Rate-card estimate, not a provider-reported amount">est.</span>`;

/** One event's cost as HTML: reported, estimated (marked), unknown, no charge or pending. */
export function eventCostHtml(e: UsageEvent): string {
  if (e.actualCostUsd !== null) return escapeHtml(money(e.actualCostUsd + e.adjustmentUsd));
  if (e.estimatedCostUsd !== null) {
    return `${escapeHtml(money(e.estimatedCostUsd + e.adjustmentUsd))}${EST_HTML}`;
  }
  if (e.chargeState === "pending") return `<span class="muted">pending</span>`;
  if (e.chargeState === "no_charge") return `<span class="muted">no charge</span>`;
  if (e.adjustmentUsd !== 0)
    return `${UNKNOWN_HTML} <small>(${escapeHtml(money(e.adjustmentUsd))} adj.)</small>`;
  return UNKNOWN_HTML;
}

/** A known total followed by how many runs had no price, so a partial sum never reads as complete. */
export function knownWithUnknown(usd: number, unknownRuns: number): string {
  const total = escapeHtml(money(usd));
  if (unknownRuns <= 0) return total;
  return `${total} <small class="unknown">+ ${count(unknownRuns)} unknown</small>`;
}

export function statusHtml(status: string): string {
  return `<span class="status-${escapeHtml(status)}">${escapeHtml(status.replace("_", " "))}</span>`;
}
