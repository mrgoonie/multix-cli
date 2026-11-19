/**
 * /models: public page of every model multix knows, grouped by task, with
 * per-provider prices. The server embeds the data as JSON; the browser
 * script (models-page-script.ts) filters, sorts and renders it.
 */

import { escapeHtml } from "../http-responses.js";
import type { ModelsData } from "../routes/models-catalog-data.js";
import { messagesFor } from "./i18n.js";
import { MODELS_SCRIPT } from "./models-page-script.js";
import { appShell } from "./page-layout.js";
import { DEFAULT_PREFERENCES, type Preferences } from "./preferences.js";

/** JSON safe inside a <script> element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const STYLES = `
.mx-controls{display:grid;gap:var(--mx-space-2);margin-bottom:var(--mx-space-3)}
.mx-controls input,.mx-controls select{min-height:36px;background:var(--mx-bg-deep);color:var(--mx-text);border:1px solid var(--mx-line-strong);border-radius:var(--mx-radius-md);padding:var(--mx-space-1) var(--mx-space-2);font:inherit;font-size:var(--mx-text-sm)}
.mx-controls input[type=search]{flex:1 1 260px;min-width:0}
.mx-controls input[type=number]{width:96px}
.mx-controls label{display:inline-flex;gap:var(--mx-space-1);align-items:center;font-size:var(--mx-text-sm);color:var(--mx-text-muted);flex-wrap:wrap}
.mx-chip{border:1px solid var(--mx-line-strong);background:transparent;color:var(--mx-text);border-radius:var(--mx-radius-pill);padding:2px 10px;font:inherit;font-size:var(--mx-text-sm);cursor:pointer}
.mx-chip[aria-pressed=true]{background:var(--mx-accent);border-color:var(--mx-accent);color:var(--mx-accent-contrast)}
.mx-chip[aria-pressed=true] .muted{color:inherit}
.mx-group{margin-top:var(--mx-space-5)}
.mx-table{width:100%;border-collapse:collapse;font-size:var(--mx-text-sm)}
.mx-table th,.mx-table td{text-align:left;padding:var(--mx-space-2);border-bottom:1px solid var(--mx-line);vertical-align:top}
.mx-table th{color:var(--mx-text-muted);font-weight:500}
.mx-main{cursor:pointer}.mx-main:hover td,.mx-main:focus td{background:var(--mx-bg-deep)}
.mx-detail td{background:var(--mx-bg-deep)}
.mx-rate{border:1px solid var(--mx-line);border-radius:var(--mx-radius-md);padding:var(--mx-space-2);margin-bottom:var(--mx-space-2)}
.mx-price{white-space:nowrap;font-variant-numeric:tabular-nums}
.mx-tag{display:inline-block;font-size:var(--mx-text-xs);border:1px solid var(--mx-line-strong);border-radius:var(--mx-radius-pill);padding:0 8px;margin:1px 4px 1px 0;color:var(--mx-text-muted);white-space:nowrap}
.mx-tag.ok{color:var(--mx-success,var(--mx-accent));border-color:currentColor}
.mx-tag.warn{color:var(--mx-warning,var(--mx-danger));border-color:currentColor}
.mx-unknown{color:var(--mx-warning,var(--mx-danger));font-style:italic}
@media (max-width:760px){.mx-table thead{display:none}.mx-table,.mx-table tbody,.mx-table tr,.mx-table td{display:block;width:100%}
.mx-main{border-bottom:1px solid var(--mx-line);padding:var(--mx-space-2) 0}.mx-main td{border:0;padding:2px var(--mx-space-2)}
.mx-main td[data-k]::before{content:attr(data-k) ": ";color:var(--mx-text-muted)}.mx-price{white-space:normal}}
`;

export function modelsPage(data: ModelsData, prefs: Preferences = DEFAULT_PREFERENCES): string {
  const t = messagesFor(prefs.lang);
  const m = t.models;
  const option = (value: string, label: string) =>
    `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  const fresh = data.sources.filter((s) => s.state === "fresh");
  const live =
    data.live_fetched_at && fresh.length
      ? m.liveAt(`${data.live_fetched_at.slice(0, 16).replace("T", " ")} UTC`)
      : m.liveNone;
  const sources = data.sources
    .map(
      (s) =>
        `<li><span class="mono">${escapeHtml(s.provider)}</span> <span class="mx-tag ${s.state === "fresh" ? "ok" : "warn"}">${escapeHtml(s.state)}</span> <span class="mono muted">${escapeHtml(s.url)}</span>${s.detail ? ` <span class="muted">(${escapeHtml(s.detail)})</span>` : ""}</li>`,
    )
    .join("");
  return appShell(
    {
      title: m.title,
      prefs,
      here: "/models",
      navLabel: t.nav.models,
      nav: [
        { href: "/models", label: t.nav.models, icon: "book", current: true },
        { href: "/models.json", label: m.json, icon: "file" },
        { href: "/api/docs", label: t.nav.apiDocs, icon: "code" },
        { href: "/dashboard", label: t.nav.dashboard, icon: "back" },
      ],
    },
    `<style>${STYLES}</style>
<section class="intro" aria-labelledby="models-h">
<p class="eyebrow">${escapeHtml(t.nav.models)}</p>
<h1 id="models-h">${m.heading}</h1>
<p class="lede">${escapeHtml(m.lede)}</p>
<p class="muted"><small>${live} ${escapeHtml(m.howTo)}</small></p>
</section>
<section class="card">
<div class="mx-controls">
<div class="row"><input type="search" id="mx-q" placeholder="${escapeHtml(m.search)}" aria-label="${escapeHtml(m.search)}">
<select id="mx-provider" aria-label="${escapeHtml(t.models.client.col.provider)}">${option("", m.anyProvider)}</select>
<label>${escapeHtml(m.sortLabel)} <select id="mx-sort">${Object.entries(m.sorts)
      .map(([k, v]) => option(k, v))
      .join("")}</select></label></div>
<div class="row" id="mx-cats"></div>
<div class="row">
<label>${escapeHtml(m.kindLabel)} <select id="mx-kind">${option("", m.anySource)}${Object.entries(
      m.client.kinds,
    )
      .map(([k, v]) => option(k, v))
      .join("")}</select></label>
<label>${escapeHtml(m.priceLabel)} <select id="mx-pstat">${option("", m.anyPrice)}${option("verified", m.priceVerified)}${option("listed", m.priceListed)}${option("unknown", m.priceUnknown)}</select></label>
<label>${escapeHtml(m.unitLabel)} <select id="mx-unit">${option("", m.anyUnit)}</select></label>
<label>${escapeHtml(m.usdLabel)} <input type="number" id="mx-pmin" min="0" step="any" placeholder="min" aria-label="${escapeHtml(m.usdLabel)} min">–<input type="number" id="mx-pmax" min="0" step="any" placeholder="max" aria-label="${escapeHtml(m.usdLabel)} max"></label>
<label>${escapeHtml(m.releasedLabel)} ${escapeHtml(m.from)} <input type="date" id="mx-dfrom"> ${escapeHtml(m.to)} <input type="date" id="mx-dto"></label>
<button type="button" class="btn secondary small" id="mx-reset">${escapeHtml(m.reset)}</button>
</div>
<p class="muted small" id="mx-stats" role="status" aria-live="polite"></p>
</div>
<div id="mx-out"></div>
</section>
<section class="card"><h2>${escapeHtml(m.sourcesTitle)}</h2><ul class="small">${sources || `<li class="muted">${escapeHtml(m.liveNone)}</li>`}</ul></section>
<script type="application/json" id="mx-models-data">${scriptJson(data)}</script>
<script type="application/json" id="mx-models-text">${scriptJson(m.client)}</script>
<script>${MODELS_SCRIPT}</script>`,
  );
}
