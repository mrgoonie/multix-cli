/**
 * Styles of the HTML pages, built only on the shared design tokens (`--mx-*`
 * from design-tokens.ts). The dashboard is the calm sibling of the landing
 * page: layered near-black or porcelain, frosted glass for the sidebar,
 * colour only for status, and no motion beyond short hover fades.
 * Fonts fall back to the system stacks in the tokens: the CSP loads none.
 */

import { DESIGN_TOKENS } from "./design-tokens.js";

const BASE = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background:radial-gradient(1100px 520px at 78% -12%,var(--mx-glow-soft),transparent 62%),var(--mx-bg);color:var(--mx-text);font:400 var(--mx-text-md)/1.6 var(--mx-font-sans);-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--mx-line-strong);text-underline-offset:3px}
a:hover{text-decoration-color:currentColor}
:focus-visible{outline:2px solid var(--mx-focus);outline-offset:2px;border-radius:var(--mx-radius-sm)}
h1,h2,h3{font-weight:500;letter-spacing:var(--mx-tracking-tight);line-height:1.15;margin:0}
h1{font-size:var(--mx-text-3xl)}
h2{font-size:var(--mx-text-lg);margin-bottom:var(--mx-space-3)}
h3{font-size:var(--mx-text-md)}
h1 em,h2 em{font-family:var(--mx-font-serif);font-style:italic;font-weight:400;letter-spacing:-.01em}
p{margin:0 0 var(--mx-space-3)}
small,.small{font-size:var(--mx-text-sm)}
.muted{color:var(--mx-text-muted)}
code,.mono{font-family:var(--mx-font-mono);font-size:.8125rem}
pre{font-family:var(--mx-font-mono);font-size:.8125rem;background:var(--mx-bg-deep);border:1px solid var(--mx-line);border-radius:var(--mx-radius-md);padding:var(--mx-space-3);overflow-x:auto;margin:0 0 var(--mx-space-3)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip{position:absolute;left:var(--mx-space-3);top:-60px;z-index:10;background:var(--mx-accent);color:var(--mx-accent-contrast);padding:var(--mx-space-2) var(--mx-space-3);border-radius:var(--mx-radius-md)}
.skip:focus{top:var(--mx-space-3)}
.eyebrow{font-family:var(--mx-font-mono);font-size:var(--mx-text-xs);letter-spacing:var(--mx-tracking-caps);text-transform:uppercase;color:var(--mx-text-muted);margin-bottom:var(--mx-space-3)}
.lede{color:var(--mx-text-muted);font-size:var(--mx-text-lg);max-width:46rem;margin-top:var(--mx-space-3)}
.brand{display:inline-flex;align-items:center;gap:var(--mx-space-2);font-weight:600;font-size:var(--mx-text-lg);letter-spacing:var(--mx-tracking-tight);text-decoration:none}
.brand-mark{width:10px;height:10px;border-radius:50%;background:var(--mx-accent);box-shadow:0 0 14px var(--mx-glow)}
.brand-tag{font-family:var(--mx-font-mono);font-size:var(--mx-text-xs);font-weight:500;letter-spacing:var(--mx-tracking-caps);color:var(--mx-text-muted);border:1px solid var(--mx-line-strong);border-radius:var(--mx-radius-pill);padding:1px 8px}
`;

const CONTROLS = `
.btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--mx-space-2);min-height:40px;border:1px solid var(--mx-accent);background:var(--mx-accent);color:var(--mx-accent-contrast);border-radius:var(--mx-radius-md);padding:var(--mx-space-2) var(--mx-space-4);font:inherit;font-weight:500;text-decoration:none;cursor:pointer;transition:opacity var(--mx-duration-fast) var(--mx-ease-out),border-color var(--mx-duration-fast) var(--mx-ease-out)}
.btn:hover{opacity:.88}
.btn.secondary{background:transparent;color:var(--mx-text);border-color:var(--mx-line-strong)}
.btn.secondary:hover{opacity:1;border-color:var(--mx-text-muted)}
.btn.danger{background:transparent;color:var(--mx-danger);border-color:var(--mx-line-strong)}
.btn.danger:hover{opacity:1;border-color:var(--mx-danger)}
.btn.small{min-height:34px;padding:var(--mx-space-1) var(--mx-space-3);font-size:var(--mx-text-sm)}
.row{display:flex;gap:var(--mx-space-2);align-items:center;flex-wrap:wrap}
.spread{justify-content:space-between}
input[type=password],input[type=text],input[type=url]{flex:1 1 240px;min-width:0;min-height:40px;background:var(--mx-bg-deep);color:var(--mx-text);border:1px solid var(--mx-line-strong);border-radius:var(--mx-radius-md);padding:var(--mx-space-2) var(--mx-space-3);font:inherit;font-size:var(--mx-text-sm)}
input::placeholder{color:var(--mx-text-muted);opacity:1}
input:focus-visible{outline:2px solid var(--mx-focus);outline-offset:1px}
.fields{display:grid;gap:var(--mx-space-3);margin-bottom:var(--mx-space-4)}
.fields label{display:grid;gap:var(--mx-space-1);color:var(--mx-text-muted)}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:var(--mx-text-xs);border-radius:var(--mx-radius-pill);padding:2px 10px;border:1px solid var(--mx-line-strong);color:var(--mx-text-muted);white-space:nowrap}
.badge.ok{color:var(--mx-ok);border-color:currentColor}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.badge.ok .dot,.status-ok .dot{box-shadow:0 0 8px currentColor}
.notice{border:1px solid var(--mx-line-strong);border-left:3px solid var(--mx-ok);padding:var(--mx-space-3) var(--mx-space-4);background:var(--mx-surface);border-radius:var(--mx-radius-md);margin-bottom:var(--mx-space-4)}
.notice.warn{border-left-color:var(--mx-warn)}
.seg{display:inline-flex;border:1px solid var(--mx-line-strong);border-radius:var(--mx-radius-pill);padding:2px;gap:2px}
.seg a{font-size:var(--mx-text-xs);text-decoration:none;color:var(--mx-text-muted);padding:4px 10px;border-radius:var(--mx-radius-pill);min-height:28px;display:inline-flex;align-items:center}
.seg a:hover{color:var(--mx-text)}
.seg a[aria-current=true]{background:var(--mx-surface-raised);color:var(--mx-text);box-shadow:0 0 0 1px var(--mx-line-strong)}
.prefs{display:flex;flex-wrap:wrap;gap:var(--mx-space-2)}
`;

const SHELL = `
.shell{display:grid;grid-template-columns:264px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;overflow-y:auto;display:flex;flex-direction:column;gap:var(--mx-space-5);padding:var(--mx-space-5) var(--mx-space-4);border-right:1px solid var(--mx-line);background:var(--mx-surface-glass);-webkit-backdrop-filter:blur(18px) saturate(1.2);backdrop-filter:blur(18px) saturate(1.2)}
.sidebar nav ul{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.nav-link{display:flex;align-items:center;gap:var(--mx-space-3);padding:var(--mx-space-2) var(--mx-space-3);border-radius:var(--mx-radius-md);color:var(--mx-text-muted);text-decoration:none;font-size:var(--mx-text-sm);min-height:38px}
.nav-link:hover{color:var(--mx-text);background:var(--mx-glow-soft)}
.nav-link[aria-current=page]{color:var(--mx-text);background:var(--mx-glow-soft);box-shadow:inset 0 0 0 1px var(--mx-line)}
.nav-link svg{flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.sidebar-foot{margin-top:auto;display:grid;gap:var(--mx-space-4);padding-top:var(--mx-space-4);border-top:1px solid var(--mx-line)}
.who{display:flex;align-items:center;gap:var(--mx-space-2);min-width:0;font-size:var(--mx-text-sm)}
.who strong{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.avatar{width:28px;height:28px;border-radius:50%;flex:none;box-shadow:0 0 0 1px var(--mx-line-strong)}
.content{padding:var(--mx-space-7) clamp(var(--mx-space-4),4vw,var(--mx-space-8)) var(--mx-space-8);max-width:1040px;width:100%}
.content>section,.content>.notice{scroll-margin-top:var(--mx-space-5)}
.intro{margin-bottom:var(--mx-space-6)}
.card{background:var(--mx-surface);border:1px solid var(--mx-line);border-radius:var(--mx-radius-lg);padding:var(--mx-space-5);margin-bottom:var(--mx-space-4);box-shadow:inset 0 1px 0 var(--mx-glow-soft)}
.card-intro{color:var(--mx-text-muted);font-size:var(--mx-text-sm);max-width:52rem}
@media (max-width:900px){
.shell{display:block}
.sidebar{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;gap:var(--mx-space-3);padding:var(--mx-space-3) var(--mx-space-4);border-right:0;border-bottom:1px solid var(--mx-line)}
.sidebar .brand{margin-right:auto}
.sidebar nav{order:3;flex:1 0 100%}
.sidebar nav ul{display:flex;flex-wrap:wrap;gap:var(--mx-space-1)}
.nav-link{padding:var(--mx-space-1) var(--mx-space-3);border:1px solid var(--mx-line);border-radius:var(--mx-radius-pill);min-height:34px}
.nav-link svg{display:none}
.sidebar-foot{order:2;margin:0;padding:0;border:0;display:flex;flex-wrap:wrap;align-items:center;gap:var(--mx-space-2)}
.sidebar-foot .who{display:none}
.content{padding:var(--mx-space-5) var(--mx-space-4) var(--mx-space-7)}
.card{padding:var(--mx-space-4)}
}
`;

const FOCUS = `
.focus{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:var(--mx-space-4)}
.focus-top{width:100%;max-width:560px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--mx-space-3);padding:var(--mx-space-3) 0 var(--mx-space-6)}
.focus main{width:100%;max-width:560px}
.panel{background:var(--mx-surface);border:1px solid var(--mx-line);border-radius:var(--mx-radius-xl);padding:clamp(var(--mx-space-5),5vw,var(--mx-space-6));box-shadow:var(--mx-shadow-lg)}
.panel h1{font-size:var(--mx-text-2xl);margin-bottom:var(--mx-space-4)}
.panel .actions{margin-top:var(--mx-space-5)}
`;

const DASHBOARD = `
.steps{list-style:none;margin:0;padding:0;display:grid;gap:0}
.step{display:grid;grid-template-columns:32px minmax(0,1fr);gap:var(--mx-space-3);padding:var(--mx-space-4) 0;border-top:1px solid var(--mx-line)}
.step:first-child{border-top:0;padding-top:0}
.step:last-child{padding-bottom:0}
.step-mark{width:28px;height:28px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--mx-line-strong);font-family:var(--mx-font-mono);font-size:var(--mx-text-xs);color:var(--mx-text-muted)}
.step-mark svg{fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.step.done .step-mark{border-color:var(--mx-ok);color:var(--mx-ok);box-shadow:0 0 12px -2px var(--mx-ok)}
.step-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--mx-space-2);margin-bottom:var(--mx-space-1)}
.step p{color:var(--mx-text-muted);font-size:var(--mx-text-sm)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--mx-space-3);margin-bottom:var(--mx-space-4)}
.stat{background:var(--mx-surface);border:1px solid var(--mx-line);border-radius:var(--mx-radius-lg);padding:var(--mx-space-4)}
.stat dt{font-size:var(--mx-text-xs);color:var(--mx-text-muted);letter-spacing:var(--mx-tracking-caps);text-transform:uppercase;font-family:var(--mx-font-mono)}
.stat dd{margin:var(--mx-space-1) 0 0;font-size:var(--mx-text-xl);letter-spacing:var(--mx-tracking-tight)}
.providers{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:var(--mx-space-2)}
.providers a{display:flex;align-items:center;justify-content:space-between;gap:var(--mx-space-2);padding:var(--mx-space-2) var(--mx-space-3);border:1px solid var(--mx-line);border-radius:var(--mx-radius-md);text-decoration:none;font-size:var(--mx-text-sm);min-height:40px}
.providers a:hover{border-color:var(--mx-line-strong);background:var(--mx-glow-soft)}
.status{display:inline-flex;align-items:center;gap:6px;font-size:var(--mx-text-xs);color:var(--mx-text-muted)}
.status-ok{color:var(--mx-ok)}
.secret{border-top:1px solid var(--mx-line);padding:var(--mx-space-4) 0}
.secret:first-of-type{border-top:0;padding-top:0}
.secret-head{display:flex;justify-content:space-between;gap:var(--mx-space-2);flex-wrap:wrap;margin-bottom:var(--mx-space-2)}
.secret-head strong{font-weight:500}
details.provider{border-top:1px solid var(--mx-line);padding:var(--mx-space-3) 0;scroll-margin-top:var(--mx-space-5)}
details.provider:first-of-type{border-top:0}
details.provider summary{cursor:pointer;display:flex;gap:var(--mx-space-2);align-items:center;flex-wrap:wrap;min-height:36px;border-radius:var(--mx-radius-sm)}
details.provider summary strong{font-weight:500}
details.provider summary::marker{color:var(--mx-text-muted)}
details.provider[open] summary{margin-bottom:var(--mx-space-3)}
details.provider .secret:first-of-type{border-top:0;padding-top:0}
table{width:100%;border-collapse:collapse}
td{padding:var(--mx-space-3) 0;border-top:1px solid var(--mx-line);vertical-align:middle}
tr:first-child td{border-top:0}
td.end{text-align:right;padding-left:var(--mx-space-3)}
td strong{font-weight:500}
.method{font-family:var(--mx-font-mono);font-size:var(--mx-text-xs);border:1px solid var(--mx-line-strong);border-radius:var(--mx-radius-sm);padding:1px 6px;margin-right:var(--mx-space-2)}
`;

const COPY = `
.copy-wrap{position:relative;display:flex;flex:1 1 240px;min-width:0;margin:0 0 var(--mx-space-3)}
.copy-wrap>input{flex:1 1 auto;padding-right:48px}
.copy-wrap>pre{flex:1 1 auto;min-width:0;margin:0;padding-right:52px;white-space:pre-wrap;overflow-wrap:anywhere}
.copy-btn{display:none;position:absolute;top:6px;right:6px;width:32px;height:32px;align-items:center;justify-content:center;border:1px solid var(--mx-line-strong);border-radius:var(--mx-radius-sm);background:var(--mx-surface-raised);color:var(--mx-text-muted);cursor:pointer;padding:0}
.js .copy-btn{display:inline-flex}
.copy-wrap>input+.copy-btn{top:50%;transform:translateY(-50%)}
.copy-btn:hover{color:var(--mx-text);border-color:var(--mx-text-muted)}
.copy-btn svg{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.copy-btn .i-done{display:none}
.copy-btn[data-state=copied]{color:var(--mx-ok);border-color:var(--mx-ok)}
.copy-btn[data-state=copied] .i-copy{display:none}.copy-btn[data-state=copied] .i-done{display:inline}
.copy-btn[data-state=failed]{color:var(--mx-danger);border-color:var(--mx-danger)}
`;

export const STYLES = `${DESIGN_TOKENS}${BASE}${CONTROLS}${SHELL}${FOCUS}${DASHBOARD}${COPY}`;
