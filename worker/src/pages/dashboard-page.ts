/**
 * Dashboard pages: the sign-in landing and the signed-in account view (an
 * app shell with the overview and onboarding, provider keys, R2 storage, API
 * keys and connected MCP clients).
 * Stored key values are never rendered: only whether one is set and when.
 */

import type { Account, SecretRecords } from "../accounts/account-store.js";
import type { ApiKeyRecord } from "../accounts/api-key-store.js";
import { escapeHtml } from "../http-responses.js";
import { type NewApiKey, apiKeysCard, newApiKeyNotice } from "./api-keys-card.js";
import { overviewSection } from "./dashboard-overview.js";
import { type Messages, messagesFor } from "./i18n.js";
import { type NoticeCode, isWarning } from "./notice-codes.js";
import { type NavItem, appShell, focusPage, formatDate } from "./page-layout.js";
import { DEFAULT_PREFERENCES, type Preferences } from "./preferences.js";
import { providerKeysCard } from "./provider-keys-card.js";
import { type R2SettingsSummary, r2SettingsCard } from "./r2-settings-card.js";

export interface ConnectedClient {
  grantId: string;
  clientName: string;
  createdAt: number;
}

export interface DashboardView {
  account: Account;
  /** Encrypted records; only their presence and `updatedAt` are rendered. */
  secrets: SecretRecords;
  /** Bucket and public URL of the saved R2 settings, or null when none are saved. */
  r2: R2SettingsSummary | null;
  csrf: string;
  /** Public origin, e.g. https://multix.zuey.me. */
  origin: string;
  mcpUrl: string;
  apiKeys: ApiKeyRecord[];
  /** Set only on the response that created the key. */
  newApiKey?: NewApiKey;
  clients: ConnectedClient[];
  notice?: NoticeCode;
  prefs: Preferences;
}

const DASHBOARD_PATH = "/dashboard";

export function signInPage(prefs: Preferences = DEFAULT_PREFERENCES): string {
  const t = messagesFor(prefs.lang);
  return focusPage(
    t.signIn.title,
    `<section class="panel">
<p class="eyebrow">${escapeHtml(t.tagline)}</p>
<h1>${t.signIn.heading}</h1>
<p class="muted">${escapeHtml(t.signIn.body)}</p>
<p class="actions"><a class="btn" href="/dashboard/login">${escapeHtml(t.signIn.button)}</a></p>
</section>`,
    prefs,
    DASHBOARD_PATH,
  );
}

function clientsCard(view: DashboardView, t: Messages): string {
  const c = t.clients;
  const rows = view.clients
    .map(
      (
        client,
      ) => `<tr><td><strong>${escapeHtml(client.clientName)}</strong><br><small class="muted">${c.connectedAt(formatDate(client.createdAt))}</small></td>
<td class="end"><form method="post" action="/dashboard/connections/revoke"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><input type="hidden" name="grant_id" value="${escapeHtml(client.grantId)}"><button class="btn danger small" aria-label="${escapeHtml(`${c.disconnect} ${client.clientName}`)}">${escapeHtml(c.disconnect)}</button></form></td></tr>`,
    )
    .join("");
  const body = rows ? `<table>${rows}</table>` : `<p class="muted">${escapeHtml(c.none)}</p>`;
  return `<section class="card" id="clients" aria-labelledby="clients-h"><h2 id="clients-h">${escapeHtml(c.heading)}</h2>${body}</section>`;
}

export function dashboardNav(t: Messages): NavItem[] {
  return [
    { href: "#overview", label: t.nav.overview, icon: "overview" },
    { href: "#provider-keys", label: t.nav.providerKeys, icon: "key" },
    { href: "#storage", label: t.nav.storage, icon: "storage" },
    { href: "#api-keys", label: t.nav.apiKeys, icon: "code" },
    { href: "#clients", label: t.nav.clients, icon: "plug" },
    { href: "/api/docs", label: t.nav.apiDocs, icon: "book" },
  ];
}

export function dashboardPage(view: DashboardView): string {
  const { account, prefs } = view;
  const t = messagesFor(prefs.lang);
  const notice = view.notice
    ? `<p class="notice${isWarning(view.notice) ? " warn" : ""}" role="status">${escapeHtml(t.notices[view.notice])}</p>`
    : "";
  const created = view.newApiKey ? newApiKeyNotice(view.newApiKey, t, prefs.lang) : "";
  return appShell(
    {
      title: t.overview.title,
      prefs,
      // A new key is shown only in this response; switching language or theme reloads and would lose it.
      here: view.newApiKey ? undefined : DASHBOARD_PATH,
      navLabel: t.nav.label,
      nav: dashboardNav(t),
      account: { login: account.login, avatarUrl: account.avatarUrl, csrf: view.csrf },
    },
    `${notice}${created}${overviewSection(view)}
${providerKeysCard(view.secrets, view.csrf, t)}
${r2SettingsCard(view.r2, view.csrf, t)}
${apiKeysCard(view.apiKeys, view.csrf, view.origin, t)}
${clientsCard(view, t)}`,
  );
}
