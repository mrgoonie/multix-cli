/**
 * Browser script of /models: reads the JSON the server embedded and renders
 * the filterable, sortable tables grouped by task. All provider data is
 * escaped before it reaches innerHTML. Strings come from the page's language.
 */

export const MODELS_SCRIPT = String.raw`(() => {
const D = JSON.parse(document.getElementById("mx-models-data").textContent);
const T = JSON.parse(document.getElementById("mx-models-text").textContent);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const url = (u) => /^https:\/\//.test(u || "") ? esc(u) : "";
const ORDER = Object.keys(T.tasks);
const fmt = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k]));
const pname = (id) => D.providers[id]?.name ?? id;
const unitName = (m) => T.meters[m] || m;
const usd = (v) => v === 0 ? "$0" : v < 0.001 ? "$" + v.toPrecision(3) : "$" + String(+v.toFixed(v < 1 ? 5 : 3));

for (const r of D.rows) {
  r.comps = [];
  for (const x of r.rates) if (x.status === "current") for (const c of x.components || []) r.comps.push({ unit: unitName(c.meter), v: c.usd / c.per });
  r.lcomps = r.listed.filter((p) => p.unit).map((p) => ({ unit: p.unit, v: p.usd }));
  r.priced = r.comps.length > 0;
  r.anyPrice = r.priced || r.listed.length > 0;
  r.checked = r.rates.map((x) => x.last_checked).sort().at(-1);
  r.allComps = r.priced ? r.comps : r.lcomps;
}

const present = ORDER.filter((t) => D.rows.some((r) => r.tasks.includes(t)));
const cats = new Set();
$("mx-provider").innerHTML += [...new Set(D.rows.map((r) => r.provider))].sort().map((p) => '<option value="' + esc(p) + '">' + esc(pname(p)) + "</option>").join("");
$("mx-unit").innerHTML += [...new Set(D.rows.flatMap((r) => r.allComps.map((c) => c.unit)))].sort().map((u) => '<option value="' + esc(u) + '">' + esc(u) + "</option>").join("");
$("mx-cats").innerHTML = '<button type="button" class="mx-chip" data-c="" aria-pressed="true">' + esc(T.all) + "</button>" +
  present.map((t) => '<button type="button" class="mx-chip" data-c="' + t + '" aria-pressed="false">' + esc(T.tasks[t]) + ' <span class="muted">' + D.rows.filter((r) => r.tasks.includes(t)).length + "</span></button>").join("");
$("mx-cats").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const c = b.dataset.c;
  if (!c) cats.clear(); else if (cats.has(c)) cats.delete(c); else cats.add(c);
  for (const x of $("mx-cats").children) x.setAttribute("aria-pressed", String(x.dataset.c ? cats.has(x.dataset.c) : cats.size === 0));
  render();
});
const ids = ["mx-q","mx-provider","mx-sort","mx-kind","mx-pstat","mx-unit","mx-pmin","mx-pmax","mx-dfrom","mx-dto"];
for (const id of ids) $(id).addEventListener("input", render);
$("mx-reset").addEventListener("click", () => { for (const id of ids) if (id !== "mx-sort") $(id).value = ""; cats.clear(); $("mx-cats").firstChild.click(); });

function best(r, u) { return r.allComps.filter((c) => !u || c.unit === u).sort((a, b) => a.unit.localeCompare(b.unit) || a.v - b.v)[0]; }
function matches(r) {
  const q = $("mx-q").value.trim().toLowerCase(), p = $("mx-provider").value, k = $("mx-kind").value, ps = $("mx-pstat").value, u = $("mx-unit").value;
  const mn = $("mx-pmin").value, mx = $("mx-pmax").value, df = $("mx-dfrom").value, dt = $("mx-dto").value;
  if (q && ![r.id, r.name, r.family, r.command, pname(r.provider)].some((s) => String(s ?? "").toLowerCase().includes(q))) return false;
  if (p && r.provider !== p) return false;
  if (k && r.kind !== k) return false;
  if (ps === "verified" && !r.priced) return false;
  if (ps === "listed" && (r.priced || !r.listed.length)) return false;
  if (ps === "unknown" && r.anyPrice) return false;
  if (u || mn || mx) {
    const cs = r.allComps.filter((c) => !u || c.unit === u);
    if (!cs.length) return false;
    if (mn && !cs.some((c) => c.v >= +mn)) return false;
    if (mx && !cs.some((c) => c.v <= +mx)) return false;
  }
  if ((df || dt) && !r.released_at) return false;
  if (df && r.released_at.slice(0, 10) < df) return false;
  if (dt && r.released_at.slice(0, 10) > dt) return false;
  return true;
}
function sorter(by, u) {
  const last = (a, b, ka, kb) => !ka || !kb ? (ka ? -1 : kb ? 1 : a.id.localeCompare(b.id)) : null;
  return (a, b) => {
    if (by === "provider") return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
    if (by === "released") return last(a, b, a.released_at, b.released_at) ?? (b.released_at.localeCompare(a.released_at) || a.id.localeCompare(b.id));
    if (by === "checked") return last(a, b, a.checked, b.checked) ?? (b.checked.localeCompare(a.checked) || a.id.localeCompare(b.id));
    if (by === "price") { const pa = best(a, u), pb = best(b, u); return last(a, b, pa, pb) ?? (pa.unit.localeCompare(pb.unit) || pa.v - pb.v || a.id.localeCompare(b.id)); }
    return (a.name || a.model).localeCompare(b.name || b.model);
  };
}
function range(cs, u) {
  const by = {};
  for (const c of cs) if (!u || c.unit === u) (by[c.unit] ??= []).push(c.v);
  return Object.entries(by).map(([unit, v]) => { const lo = Math.min(...v), hi = Math.max(...v); return '<div class="mx-price">' + usd(lo) + (hi > lo ? " – " + usd(hi) : "") + ' <span class="muted">/ ' + esc(unit) + "</span></div>"; }).join("");
}
function link(r) { return r.price_link && url(r.price_link) ? ' <a href="' + url(r.price_link) + '" target="_blank" rel="noopener">' + esc(T.checkProvider) + " ↗</a>" : ""; }
function priceCell(r, u) {
  if (r.priced) return range(r.comps, u) + (r.rates.length > 1 ? '<div class="muted small">' + esc(fmt(T.configs, { n: r.rates.length })) + "</div>" : "");
  if (r.listed.length) {
    const withUnit = range(r.lcomps, u);
    const noUnit = r.listed.filter((p) => !p.unit).map((p) => '<div class="mx-price">' + usd(p.usd) + ' <span class="muted">· ' + esc(T.unitNotStated) + "</span></div>").join("");
    return withUnit + noUnit + '<div class="muted small">' + esc(T.listedNote) + "</div>";
  }
  const why = T.problems[r.rates[0]?.status] || T.unknown;
  return '<span class="mx-unknown">' + esc(why) + "</span>" + link(r);
}
function detail(r) {
  let h = "";
  for (const x of r.rates) {
    const cfg = Object.entries(x.config || {}).map(([k, v]) => '<span class="mx-tag">' + esc(k) + ": " + esc(v) + "</span>").join("");
    h += '<div class="mx-rate"><div><span class="mono">' + esc(x.id) + '</span> <span class="mx-tag ' + (x.status === "current" ? "ok" : "warn") + '">' + esc(x.status === "current" ? T.current : (T.problems[x.status] || x.status)) + '</span> <span class="mx-tag">' + esc(x.basis === "estimated" ? T.estimated : T.list) + "</span>" + cfg + "</div>" +
      '<div class="small">' + (x.units.length ? x.units.map(esc).join("<br>") : '<span class="mx-unknown">' + esc(x.detail || T.unknown) + "</span>") + "</div>" +
      (x.notes ? '<div class="small muted">' + esc(x.notes) + "</div>" : "") +
      '<div class="small muted">' + esc(T.checkedOn) + " " + esc(x.last_checked) + " · " + (url(x.source) ? '<a href="' + url(x.source) + '" target="_blank" rel="noopener">' + esc(x.source) + "</a>" : esc(x.source)) + "</div></div>";
  }
  if (r.listed.length) h += '<div class="mx-rate"><div><span class="mx-tag warn">' + esc(T.kinds.listed) + "</span></div><div class=\"small\">" + r.listed.map((p) => esc(p.label) + ": " + usd(p.usd) + (p.unit ? " / " + esc(p.unit) : " (" + esc(T.unitNotStated) + ")")).join("<br>") + '</div><div class="small muted">' + esc(T.listedDetail) + "</div></div>";
  if (r.kind === "command") h += '<div class="small muted">' + esc(T.commandDetail) + ' <code>multix ' + esc(r.command) + "</code></div>";
  const pi = D.providers[r.provider];
  if (pi && url(pi.pricing_url || pi.homepage)) h += '<div class="small muted">' + esc(T.providerPage) + ' <a href="' + url(pi.pricing_url || pi.homepage) + '" target="_blank" rel="noopener">' + esc(pi.pricing_url || pi.homepage) + "</a></div>";
  return h;
}
const open = new Set();
function render() {
  const by = $("mx-sort").value, u = $("mx-unit").value;
  const list = D.rows.filter(matches).sort(sorter(by, u));
  const shown = new Set();
  let html = "";
  for (const t of cats.size ? ORDER.filter((c) => cats.has(c)) : present) {
    const rs = list.filter((r) => r.tasks.includes(t)); if (!rs.length) continue;
    rs.forEach((r) => shown.add(r));
    html += '<section class="mx-group"><h2>' + esc(T.tasks[t]) + ' <span class="muted small">' + esc(fmt(T.groupCount, { n: rs.length, p: rs.filter((r) => r.anyPrice).length })) + "</span></h2>" +
      '<table class="mx-table"><thead><tr><th>' + esc(T.col.model) + "</th><th>" + esc(T.col.provider) + "</th><th>" + esc(T.col.price) + "</th><th>" + esc(T.col.source) + "</th><th>" + esc(T.col.released) + "</th></tr></thead><tbody>" +
      rs.map((r) => { const key = t + "|" + r.id; return '<tr class="mx-main" data-id="' + esc(key) + '" tabindex="0" aria-expanded="' + open.has(key) + '"><td><div>' + esc(r.name || r.model) + '</div><div class="mono muted">' + esc(r.model) + "</div>" + (r.family ? '<span class="mx-tag">' + esc(r.family) + "</span>" : "") + "</td>" +
        '<td data-k="' + esc(T.col.provider) + '">' + esc(pname(r.provider)) + '</td><td data-k="' + esc(T.col.price) + '">' + priceCell(r, u) + '</td><td data-k="' + esc(T.col.source) + '"><span class="mx-tag ' + (r.kind === "verified" ? "ok" : r.kind === "listed" ? "warn" : "") + '">' + esc(T.kinds[r.kind]) + "</span></td>" +
        '<td data-k="' + esc(T.col.released) + '">' + (r.released_at ? esc(r.released_at.slice(0, 10)) : '<span class="muted">—</span>') + "</td></tr>" +
        (open.has(key) ? '<tr class="mx-detail"><td colspan="5">' + detail(r) + "</td></tr>" : ""); }).join("") + "</tbody></table></section>";
  }
  $("mx-out").innerHTML = html || '<p class="muted">' + esc(T.empty) + "</p>";
  $("mx-stats").textContent = fmt(T.stats, { shown: shown.size, total: D.rows.length, priced: [...shown].filter((r) => r.anyPrice).length });
}
function toggle(tr) { const id = tr.dataset.id; if (open.has(id)) open.delete(id); else open.add(id); render(); }
$("mx-out").addEventListener("click", (e) => { const tr = e.target.closest("tr.mx-main"); if (tr && !e.target.closest("a")) toggle(tr); });
$("mx-out").addEventListener("keydown", (e) => { const tr = e.target.closest("tr.mx-main"); if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(tr); } });
render();
})();`;

/** `sha256-<base64>` of MODELS_SCRIPT, as used in the CSP `script-src` (a test keeps it in sync). */
export const MODELS_SCRIPT_HASH = "sha256-h2yfJLAUW2RQ19u1pfYPL1n4TgrYT6Axt07gK+P2FFM=";
