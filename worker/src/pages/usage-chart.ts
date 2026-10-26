/**
 * Daily known-cost bar chart (inline SVG, no script) with a separate marker
 * row for operations whose cost is unknown, plus a text table fallback with
 * the same numbers for screen readers and narrow screens.
 */

import { escapeHtml } from "../http-responses.js";
import type { UsageSummary } from "../ledger/ledger-types.js";
import { count, dataTable, isoDay, money, usdText } from "./finops-format.js";

const DAY_MS = 86_400_000;
/** More days than this are not drawn one bar each (the range cap is 400 days). */
const MAX_BARS = 400;

interface DayPoint {
  start: number;
  known: number;
  unknown: number;
  operations: number;
}

/** One point per UTC day of the range, days without operations included. */
export function dailyPoints(summary: UsageSummary): DayPoint[] {
  const byDay = new Map(summary.series.map((s) => [s.bucket_start, s]));
  const first = Math.floor(summary.from / DAY_MS) * DAY_MS;
  const points: DayPoint[] = [];
  for (let day = first; day < summary.to && points.length < MAX_BARS; day += DAY_MS) {
    const s = byDay.get(day);
    points.push({
      start: day,
      known: s?.known_cost_usd ?? 0,
      unknown: s?.unknown_cost_operations ?? 0,
      operations: s?.operations ?? 0,
    });
  }
  return points;
}

export function costChart(summary: UsageSummary): string {
  const points = dailyPoints(summary);
  if (points.length === 0) return "";
  const width = 1000;
  const top = 18;
  const plot = 160;
  const markerRow = plot + top + 14;
  const height = markerRow + 26;
  const step = width / points.length;
  const barWidth = Math.max(1, step * 0.75);
  const max = Math.max(0, ...points.map((p) => p.known));
  const unknownDays = points.filter((p) => p.unknown > 0).length;
  const bars = points
    .map((p, i) => {
      const x = (i * step + (step - barWidth) / 2).toFixed(1);
      const label = `${isoDay(p.start)}: known cost ${usdText(p.known)} USD, ${p.operations} operations, ${p.unknown} with unknown cost`;
      const h = max > 0 ? (p.known / max) * plot : 0;
      const bar =
        p.known !== 0
          ? `<rect class="bar" x="${x}" y="${(top + plot - Math.max(h, 1)).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}"><title>${escapeHtml(label)}</title></rect>`
          : "";
      const marker =
        p.unknown > 0
          ? `<rect class="unk" x="${x}" y="${markerRow}" width="${barWidth.toFixed(1)}" height="8"><title>${escapeHtml(label)}</title></rect>`
          : "";
      return bar + marker;
    })
    .join("");
  const firstLabel = isoDay(points[0]?.start ?? summary.from);
  const lastLabel = isoDay(points[points.length - 1]?.start ?? summary.to);
  const description = `Known cost per day from ${firstLabel} to ${lastLabel}, highest day ${usdText(max)} USD. ${unknownDays} day(s) had operations with unknown cost, marked in the lower row.`;
  const svg = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title chart-desc">
<title id="chart-title">Daily known cost (USD)</title>
<desc id="chart-desc">${escapeHtml(description)}</desc>
<line class="axis" x1="0" y1="${top + plot}" x2="${width}" y2="${top + plot}"/>
<text x="2" y="12">${escapeHtml(usdText(max))}</text>
${bars}
<text x="2" y="${height - 2}">${escapeHtml(firstLabel)}</text>
<text x="${width - 2}" y="${height - 2}" text-anchor="end">${escapeHtml(lastLabel)}</text>
</svg>`;
  const legend = `<div class="legend"><span><span class="swatch" style="background:var(--accent)"></span>Known cost</span><span><span class="swatch" style="background:var(--warn)"></span>Days with unknown-cost operations (not included in the bars)</span></div>`;
  const rows = points
    .filter((p) => p.operations > 0)
    .map((p) => [
      escapeHtml(isoDay(p.start)),
      count(p.operations),
      money(p.known),
      count(p.unknown),
    ]);
  const table = rows.length
    ? dataTable(
        ["Day (UTC)", "Operations", "Known cost (USD)", "Unknown-cost operations"],
        rows,
        [1, 2, 3],
      )
    : '<p class="muted">No operations in this range.</p>';
  return `${svg}${legend}<details><summary>Daily numbers as a table</summary>${table}</details>`;
}
