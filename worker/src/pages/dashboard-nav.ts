/**
 * Tabs shown on every signed-in dashboard page, and the shell that wraps a
 * tab's content (wide column, notice, nav). Links only: no script.
 */

import { escapeHtml } from "../http-responses.js";
import { page } from "./page-layout.js";

export type DashboardTab = "overview" | "usage" | "budgets" | "traces" | "activities" | "settings";

const TABS: ReadonlyArray<{ tab: DashboardTab; href: string; label: string }> = [
  { tab: "overview", href: "/dashboard/overview", label: "Overview" },
  { tab: "usage", href: "/dashboard/usage", label: "Usage & Costs" },
  { tab: "budgets", href: "/dashboard/budgets", label: "Budgets" },
  { tab: "traces", href: "/dashboard/traces", label: "Traces" },
  { tab: "activities", href: "/dashboard/activities", label: "Activities" },
  { tab: "settings", href: "/dashboard", label: "Settings" },
];

export interface PageNotice {
  text: string;
  warn?: boolean;
}

export function dashboardNav(current: DashboardTab): string {
  const links = TABS.map(
    (t) =>
      `<a href="${t.href}"${t.tab === current ? ' aria-current="page"' : ""}>${escapeHtml(t.label)}</a>`,
  ).join("");
  return `<nav class="tabs" aria-label="Dashboard">${links}</nav>`;
}

export function noticeHtml(notice: PageNotice | undefined): string {
  if (!notice) return "";
  return `<p class="notice${notice.warn ? " warn" : ""}" role="status">${escapeHtml(notice.text)}</p>`;
}

/** A dashboard tab page: nav, optional notice, then the tab's content. */
export function dashboardShell(
  title: string,
  current: DashboardTab,
  body: string,
  notice?: PageNotice,
): string {
  return page(
    `${title} · multix MCP dashboard`,
    `${dashboardNav(current)}${noticeHtml(notice)}${body}`,
    {
      wide: true,
    },
  );
}

export function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

export const LEDGER_MISSING: PageNotice = {
  text: "The usage ledger is not configured on this server, so there is no usage data to show.",
  warn: true,
};

export const LEDGER_FAILED: PageNotice = {
  text: "Usage data could not be loaded right now. Try again in a moment.",
  warn: true,
};
