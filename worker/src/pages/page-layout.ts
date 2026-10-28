/**
 * Shared HTML shells for the dashboard, API docs, consent and message pages:
 * `appShell` (sidebar navigation that turns into a top bar on narrow screens)
 * and `focusPage` (one centred panel). Both are server-rendered and work
 * without JavaScript; the only script is COPY_SCRIPT (copy buttons), which the
 * CSP in http-responses.ts allows by hash.
 * Every interpolated value must go through escapeHtml().
 */

import { escapeHtml } from "../http-responses.js";
import { COPY_SCRIPT } from "./copy-script.js";
import { type Messages, messagesFor } from "./i18n.js";
import { NAV_ICONS, type NavIcon } from "./nav-icons.js";
import { STYLES } from "./page-styles.js";
import { DEFAULT_PREFERENCES, type Preferences, THEMES, switchHref } from "./preferences.js";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  current?: boolean;
}

/** The signed-in account shown at the foot of the sidebar, with its sign-out form. */
export interface ShellAccount {
  login: string;
  avatarUrl?: string;
  csrf: string;
}

export interface ShellOptions {
  title: string;
  prefs: Preferences;
  /** This page's GET URL (path and query), the base of the language and theme links. */
  here: string;
  navLabel: string;
  nav: NavItem[];
  account?: ShellAccount;
}

/** The copy script and its live region, only on pages that have a copy button. */
function copySupport(body: string, t: Messages): string {
  if (!body.includes("data-copy")) return "";
  return `<div id="copy-status" class="sr-only" role="status" aria-live="polite" data-copied="${escapeHtml(t.copy.copied)}" data-failed="${escapeHtml(t.copy.failed)}"></div><script>${COPY_SCRIPT}</script>`;
}

function htmlDocument(title: string, prefs: Preferences, body: string): string {
  const t = messagesFor(prefs.lang);
  const theme = prefs.theme === "auto" ? "" : ` data-theme="${prefs.theme}"`;
  return `<!doctype html>
<html lang="${prefs.lang}"${theme}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body><a class="skip" href="#main">${escapeHtml(t.skipToContent)}</a>
${body}${copySupport(body, t)}</body>
</html>`;
}

function brand(t: Messages, href = "/dashboard"): string {
  return `<a class="brand" href="${href}"><span class="brand-mark" aria-hidden="true"></span>multix <span class="brand-tag">${escapeHtml(t.brandTag)}</span></a>`;
}

/** The EN/VI and Auto/Light/Dark switches: plain links, so they work without JavaScript. */
export function preferenceSwitches(prefs: Preferences, here: string): string {
  const t = messagesFor(prefs.lang);
  const link = (
    key: "lang" | "theme",
    value: string,
    label: string,
    current: boolean,
    extra = "",
  ) =>
    `<a href="${escapeHtml(switchHref(here, key, value))}"${current ? ' aria-current="true"' : ""}${extra}>${escapeHtml(label)}</a>`;
  const langs = [
    link("lang", "en", "EN", prefs.lang === "en", ' lang="en" title="English"'),
    link("lang", "vi", "VI", prefs.lang === "vi", ' lang="vi" title="Tiếng Việt"'),
  ].join("");
  const themes = THEMES.map((theme) =>
    link("theme", theme, t.prefs[theme], prefs.theme === theme),
  ).join("");
  return `<div class="prefs"><div class="seg" role="group" aria-label="${escapeHtml(t.prefs.language)}">${langs}</div><div class="seg" role="group" aria-label="${escapeHtml(t.prefs.theme)}">${themes}</div></div>`;
}

function navList(items: NavItem[]): string {
  return items
    .map(
      (item) =>
        `<li><a class="nav-link" href="${escapeHtml(item.href)}"${item.current ? ' aria-current="page"' : ""}>${NAV_ICONS[item.icon]}<span>${escapeHtml(item.label)}</span></a></li>`,
    )
    .join("");
}

function accountBlock(account: ShellAccount, t: Messages): string {
  const avatar = account.avatarUrl
    ? `<img class="avatar" src="${escapeHtml(account.avatarUrl)}" alt="" width="28" height="28">`
    : "";
  return `<div class="who">${avatar}<span class="sr-only">${escapeHtml(t.account.signedInAs)}</span><strong>${escapeHtml(account.login)}</strong></div>
<form method="post" action="/dashboard/logout"><input type="hidden" name="csrf" value="${escapeHtml(account.csrf)}"><button class="btn secondary small" title="${escapeHtml(t.account.signOutTitle)}">${escapeHtml(t.account.signOut)}</button></form>`;
}

/** Sidebar navigation and a main column; the sidebar becomes a top bar below 900px. */
export function appShell(options: ShellOptions, body: string): string {
  const t = messagesFor(options.prefs.lang);
  const account = options.account ? accountBlock(options.account, t) : "";
  return htmlDocument(
    options.title,
    options.prefs,
    `<div class="shell">
<header class="sidebar">
${brand(t)}
<nav aria-label="${escapeHtml(options.navLabel)}"><ul>${navList(options.nav)}</ul></nav>
<div class="sidebar-foot">${account}${preferenceSwitches(options.prefs, options.here)}</div>
</header>
<main id="main" class="content">
${body}
</main>
</div>`,
  );
}

/**
 * One centred panel (sign-in, consent, messages). `here` adds the language
 * and theme switches; pages without a safe GET URL to return to leave it out.
 */
export function focusPage(
  title: string,
  body: string,
  prefs: Preferences = DEFAULT_PREFERENCES,
  here?: string,
): string {
  const t = messagesFor(prefs.lang);
  const switches = here ? preferenceSwitches(prefs, here) : "";
  return htmlDocument(
    title,
    prefs,
    `<div class="focus">
<header class="focus-top">${brand(t)}${switches}</header>
<main id="main">
${body}
</main>
</div>`,
  );
}

/** Minute-precision UTC timestamp for "saved at" and "connected at" labels. */
export function formatDate(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A single-panel page for errors and simple notices; title and message are plain text. */
export function messagePage(
  title: string,
  message: string,
  action?: { href: string; label: string },
  prefs: Preferences = DEFAULT_PREFERENCES,
): string {
  const link = action
    ? `<p class="actions"><a class="btn secondary" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a></p>`
    : "";
  return focusPage(
    title,
    `<section class="panel"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${link}</section>`,
    prefs,
  );
}
