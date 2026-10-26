/**
 * Server-rendered inline SVG charts (the dashboard runs no chart script).
 * Every chart has role="img", a <title> and a <desc>; each bar or span has
 * its own <title> as a tooltip. Colours come from CSS classes in STYLES.
 */

import { escapeHtml } from "../http-responses.js";
import type { UsageSpan } from "../usage/usage-types.js";
import { durationText, money } from "./usage-format.js";

let chartSeq = 0;
function chartId(prefix: string): string {
  chartSeq = (chartSeq + 1) % 1_000_000;
  return `${prefix}-${chartSeq}`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export interface CostBar {
  /** Short axis label, e.g. `10-26` or `14:00`. */
  label: string;
  /** Full label for the tooltip, e.g. `2026-10-26`. */
  title: string;
  /** Provider-reported or billed USD (adjustments included). */
  actualUsd: number;
  /** Rate-card estimates. */
  estimatedUsd: number;
  unknownCostRuns: number;
  jobs: number;
}

/**
 * Stacked bars: reported/billed below, estimated above; a warning dot over a
 * bar whose period has runs without any price.
 */
export function costBarChart(bars: CostBar[], title: string): string {
  const id = chartId("cost");
  const width = 720;
  const height = 220;
  const left = 64;
  const right = 8;
  const top = 16;
  const bottom = 26;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const totals = bars.map((b) => Math.max(0, b.actualUsd) + Math.max(0, b.estimatedUsd));
  const max = Math.max(0, ...totals);
  const unknownTotal = bars.reduce((n, b) => n + b.unknownCostRuns, 0);
  const desc = `${bars.length} periods. Highest known cost in one period: ${money(max)}.${
    unknownTotal > 0 ? ` ${unknownTotal} runs have no known price (marked with a dot).` : ""
  }`;
  const parts: string[] = [];
  const ticks = max > 0 ? [0, max / 2, max] : [0];
  for (const t of ticks) {
    const y = round1(top + plotH - (max > 0 ? (t / max) * plotH : 0));
    parts.push(
      `<line class="grid" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/><text x="${left - 6}" y="${y + 4}" text-anchor="end">${escapeHtml(money(t))}</text>`,
    );
  }
  const slot = bars.length > 0 ? plotW / bars.length : plotW;
  const barW = Math.max(1, Math.min(28, slot * 0.7));
  const labelEvery = Math.max(1, Math.ceil(bars.length / 10));
  bars.forEach((b, i) => {
    const x = round1(left + i * slot + (slot - barW) / 2);
    const actual = Math.max(0, b.actualUsd);
    const est = Math.max(0, b.estimatedUsd);
    const hA = max > 0 ? (actual / max) * plotH : 0;
    const hE = max > 0 ? (est / max) * plotH : 0;
    const base = top + plotH;
    const tip = `${b.title}: ${money(actual)} reported or billed, ${money(est)} estimated, ${b.jobs} jobs${
      b.unknownCostRuns > 0 ? `, ${b.unknownCostRuns} with unknown cost` : ""
    }`;
    let g = `<g><title>${escapeHtml(tip)}</title><rect x="${x}" y="${top}" width="${round1(barW)}" height="${plotH}" fill="transparent"/>`;
    if (hA > 0)
      g += `<rect class="c-actual" x="${x}" y="${round1(base - hA)}" width="${round1(barW)}" height="${round1(hA)}"/>`;
    if (hE > 0)
      g += `<rect class="c-est" x="${x}" y="${round1(base - hA - hE)}" width="${round1(barW)}" height="${round1(hE)}"/>`;
    if (b.unknownCostRuns > 0)
      g += `<circle class="c-unknown" cx="${round1(x + barW / 2)}" cy="${round1(Math.max(top - 6, base - hA - hE - 6))}" r="3.5"/>`;
    g += "</g>";
    parts.push(g);
    if (i % labelEvery === 0) {
      parts.push(
        `<text x="${round1(x + barW / 2)}" y="${height - 8}" text-anchor="middle">${escapeHtml(b.label)}</text>`,
      );
    }
  });
  if (max === 0) {
    parts.push(
      `<text x="${left + plotW / 2}" y="${top + plotH / 2}" text-anchor="middle">No known cost in this range</text>`,
    );
  }
  return `<div class="chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${id}-t ${id}-d" xmlns="http://www.w3.org/2000/svg"><title id="${id}-t">${escapeHtml(title)}</title><desc id="${id}-d">${escapeHtml(desc)}</desc>${parts.join("")}</svg></div>
<div class="legend"><span><span class="swatch actual"></span>Reported or billed</span><span><span class="swatch est"></span>Estimated</span><span><span class="swatch unknown"></span>Has runs with unknown cost</span></div>`;
}

/** One row per span on a shared time axis, starting at the earliest span. */
export function spanWaterfall(spans: UsageSpan[], title: string): string {
  const id = chartId("spans");
  const valid = spans.filter((s) => Number.isFinite(s.start) && s.end >= s.start);
  if (valid.length === 0) return `<p class="muted">No timing spans were recorded for this run.</p>`;
  const t0 = Math.min(...valid.map((s) => s.start));
  const t1 = Math.max(...valid.map((s) => s.end));
  const total = Math.max(1, t1 - t0);
  const width = 720;
  const left = 90;
  const right = 90;
  const rowH = 26;
  const top = 8;
  const plotW = width - left - right;
  const height = top + valid.length * rowH + 22;
  const rows = valid.map((s, i) => {
    const y = top + i * rowH;
    const x = left + ((s.start - t0) / total) * plotW;
    const w = Math.max(2, ((s.end - s.start) / total) * plotW);
    const tip = `${s.name}: ${durationText(s.end - s.start)}, starts at +${durationText(s.start - t0)}`;
    return `<g><title>${escapeHtml(tip)}</title><text x="${left - 8}" y="${y + 16}" text-anchor="end">${escapeHtml(s.name)}</text><rect class="c-track" x="${left}" y="${y + 6}" width="${plotW}" height="12" rx="3" fill-opacity=".35"/><rect class="c-span" x="${round1(x)}" y="${y + 6}" width="${round1(w)}" height="12" rx="3"/><text x="${round1(Math.min(x + w + 6, width - right + 6))}" y="${y + 16}">${escapeHtml(durationText(s.end - s.start))}</text></g>`;
  });
  const axisY = top + valid.length * rowH + 14;
  const axis = `<text x="${left}" y="${axisY}">0</text><text x="${left + plotW}" y="${axisY}" text-anchor="end">${escapeHtml(durationText(total))}</text>`;
  const desc = valid.map((s) => `${s.name} ${durationText(s.end - s.start)}`).join(", ");
  return `<div class="chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${id}-t ${id}-d" xmlns="http://www.w3.org/2000/svg"><title id="${id}-t">${escapeHtml(title)}</title><desc id="${id}-d">${escapeHtml(desc)}</desc>${rows.join("")}${axis}</svg></div>`;
}

/** Progress bar (HTML, not SVG) for a budget: warns near the limit, turns red over it. */
export function progressBar(percent: number, label: string): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const cls = percent >= 100 ? " over" : percent >= 80 ? " near" : "";
  return `<div class="bar${cls}" role="progressbar" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(clamped)}"><span style="width:${round1(clamped)}%"></span></div>`;
}
