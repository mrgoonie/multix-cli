/**
 * Shared HTML shell for the dashboard, consent and message pages.
 * Server-rendered. The only script is COPY_SCRIPT (copy buttons), which the
 * CSP in http-responses.ts allows by hash; everything else works without it.
 * Every interpolated value must go through escapeHtml().
 */

import { escapeHtml } from "../http-responses.js";
import { COPY_SCRIPT } from "./copy-script.js";

const STYLES = `
:root{--bg:#f6f7f9;--card:#fff;--text:#14161a;--muted:#5c6370;--border:#dfe2e7;--accent:#2f5bea;--accent-text:#fff;--ok:#1d7a46;--warn:#9a5b00;--danger:#c2312b;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--text:#e8eaee;--muted:#9aa1ad;--border:#2a2f38;--accent:#6d8cff;--accent-text:#0f1115;--ok:#4cc38a;--warn:#e0a84a;--danger:#ff6b63}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:24px;flex-wrap:wrap}
.brand{font-weight:700;font-size:18px;letter-spacing:-.01em}
.brand span{color:var(--muted);font-weight:500}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
h1{font-size:22px;margin:0 0 8px}h2{font-size:16px;margin:0 0 12px}
p{margin:0 0 12px}.muted{color:var(--muted)}small{font-size:13px}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
pre{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;overflow-x:auto;margin:0 0 12px}
.btn{display:inline-block;border:1px solid var(--accent);background:var(--accent);color:var(--accent-text);border-radius:8px;padding:8px 14px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.btn.secondary{background:transparent;color:var(--text);border-color:var(--border)}
.btn.danger{background:transparent;color:var(--danger);border-color:var(--border)}
.btn.small{padding:4px 10px;font-size:13px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.secret{border-top:1px solid var(--border);padding:14px 0}
.secret:first-of-type{border-top:0;padding-top:0}
.secret-head{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px}
input[type=password],input[type=text],input[type=url]{flex:1 1 260px;min-width:0;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font:inherit}
.badge{font-size:12px;border-radius:999px;padding:2px 8px;border:1px solid var(--border)}
.badge.ok{color:var(--ok);border-color:currentColor}.badge.off{color:var(--muted)}
.notice{border-left:3px solid var(--ok);padding:8px 12px;background:var(--card);border-radius:8px;margin-bottom:16px}
.notice.warn{border-color:var(--warn)}
.avatar{width:28px;height:28px;border-radius:50%;vertical-align:middle;margin-right:6px}
table{width:100%;border-collapse:collapse}td{padding:8px 0;border-top:1px solid var(--border);vertical-align:middle}
tr:first-child td{border-top:0}
details.provider{border-top:1px solid var(--border);padding:10px 0}
details.provider:first-of-type{border-top:0}
details.provider summary{cursor:pointer;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
details.provider[open] summary{margin-bottom:10px}
details.provider .secret:first-of-type{border-top:0;padding-top:0}
.fields{display:grid;gap:8px;margin-bottom:12px}
.fields label{display:grid;gap:4px}
.copy-wrap{position:relative;display:flex;flex:1 1 260px;min-width:0;margin:0 0 12px}
.copy-wrap>input{flex:1 1 auto;padding-right:44px}
.copy-wrap>pre{flex:1 1 auto;min-width:0;margin:0;padding-right:48px;white-space:pre-wrap;overflow-wrap:anywhere}
.copy-btn{display:none;position:absolute;top:6px;right:6px;width:30px;height:30px;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--muted);cursor:pointer;padding:0}
.js .copy-btn{display:inline-flex}
.copy-wrap>input+.copy-btn{top:50%;transform:translateY(-50%)}
.copy-btn:hover{color:var(--text);border-color:var(--muted)}
.copy-btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.copy-btn svg{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.copy-btn .i-done{display:none}
.copy-btn[data-state=copied]{color:var(--ok);border-color:var(--ok)}
.copy-btn[data-state=copied] .i-copy{display:none}.copy-btn[data-state=copied] .i-done{display:inline}
.copy-btn[data-state=failed]{color:var(--danger);border-color:var(--danger)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
main.wide{max-width:1120px}
nav.tabs{display:flex;gap:4px;overflow-x:auto;margin:0 0 16px;border-bottom:1px solid var(--border);scrollbar-width:thin}
nav.tabs a{flex:0 0 auto;padding:8px 12px;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px;font-weight:600;font-size:14px}
nav.tabs a:hover{color:var(--text)}
nav.tabs a[aria-current=page]{color:var(--text);border-bottom-color:var(--accent)}
a{color:var(--accent)}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;margin-bottom:16px}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px 14px;min-width:0}
.kpi .label{color:var(--muted);font-size:13px}
.kpi .value{font-size:22px;font-weight:700;letter-spacing:-.01em;overflow-wrap:anywhere}
.kpi .sub{color:var(--muted);font-size:12px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:16px}
.grid2>.card{margin-bottom:0}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table.data{font-size:14px}
table.data th{text-align:left;font-size:12px;font-weight:600;color:var(--muted);padding:6px 8px 6px 0;border-bottom:1px solid var(--border);white-space:nowrap}
table.data td{padding:6px 8px 6px 0;white-space:nowrap;vertical-align:top}
table.data tr:first-child td{border-top:0}
table.data td.wrap{white-space:normal;overflow-wrap:anywhere;min-width:160px}
.num{text-align:right!important;font-variant-numeric:tabular-nums}
.est{color:var(--warn);font-size:12px}
.unknown{color:var(--warn);font-weight:600}
.status-succeeded{color:var(--ok)}.status-failed,.status-timed_out,.status-rejected{color:var(--danger)}.status-canceled{color:var(--muted)}
.chart{overflow-x:auto;margin:0 0 8px}
.chart svg{display:block;width:100%;min-width:560px;height:auto}
.chart text{fill:var(--muted);font:11px system-ui,sans-serif}
.chart .grid{stroke:var(--border);stroke-width:1}
.c-actual{fill:var(--accent)}.c-est{fill:var(--accent);fill-opacity:.4}.c-unknown{fill:var(--warn)}.c-span{fill:var(--accent)}.c-track{fill:var(--border)}
.legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-bottom:8px}
.swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.swatch.actual{background:var(--accent)}.swatch.est{background:var(--accent);opacity:.4}.swatch.unknown{background:var(--warn)}
.bar{height:8px;border-radius:999px;background:var(--border);overflow:hidden;margin:6px 0}
.bar>span{display:block;height:100%;background:var(--accent)}
.bar.over>span{background:var(--danger)}.bar.near>span{background:var(--warn)}
.filters{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;align-items:end}
.filters label,.form-grid label{display:grid;gap:2px;font-size:13px;color:var(--muted)}
.form-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:12px}
input[type=date],input[type=number],input[type=search],select,textarea{width:100%;min-width:0;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:7px 9px;font:inherit}
.filters input[type=text],.form-grid input[type=text]{width:100%;flex:none}
textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;min-height:160px}
dl.facts{display:grid;grid-template-columns:minmax(120px,auto) 1fr;gap:4px 16px;margin:0}
dl.facts dt{color:var(--muted);font-size:13px}dl.facts dd{margin:0;overflow-wrap:anywhere}
.budget{border-top:1px solid var(--border);padding:12px 0}
.budget:first-of-type{border-top:0;padding-top:0}
.pager{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
h1.mono{font-size:20px;overflow-wrap:anywhere}
.budget-item+.budget-item{border-top:1px solid var(--border);padding-top:12px;margin-top:12px}
.budget-item>.budget{padding:0;border:0}
.budget-item details summary{cursor:pointer;font-size:14px}
@media (max-width:480px){main{padding:20px 12px 48px}.card{padding:14px}.kpi .value{font-size:19px}dl.facts{grid-template-columns:1fr}dl.facts dd{margin-bottom:6px}}
`;

/** The copy script and its live region, only on pages that have a copy button. */
function copySupport(body: string): string {
  if (!body.includes("data-copy")) return "";
  return `<div id="copy-status" class="sr-only" role="status" aria-live="polite"></div><script>${COPY_SCRIPT}</script>`;
}

export interface PageOptions {
  /** Wider column for tables and charts (dashboard pages). */
  wide?: boolean;
}

export function page(title: string, body: string, options: PageOptions = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body><main${options.wide ? ' class="wide"' : ""}>
<header><div class="brand">multix <span>MCP</span></div></header>
${body}
</main>${copySupport(body)}</body>
</html>`;
}

/** Minute-precision UTC timestamp for "saved at" and "connected at" labels. */
export function formatDate(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A single-card page for errors and simple notices. */
export function messagePage(
  title: string,
  message: string,
  action?: { href: string; label: string },
): string {
  const link = action
    ? `<p><a class="btn secondary" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a></p>`
    : "";
  return page(
    title,
    `<section class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${link}</section>`,
  );
}
