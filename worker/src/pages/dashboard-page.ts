/**
 * Dashboard pages: the sign-in landing and the signed-in account view
 * (connection instructions, provider keys, R2 storage, API keys, connected
 * MCP clients).
 * Stored key values are never rendered: only whether one is set and when.
 */

import type { Account, SecretRecords } from "../accounts/account-store.js";
import type { ApiKeyRecord } from "../accounts/api-key-store.js";
import { escapeHtml } from "../http-responses.js";
import { type NewApiKey, apiKeysCard, newApiKeyNotice } from "./api-keys-card.js";
import { copyBlock } from "./copy-button.js";
import { dashboardTabs } from "./finops-format.js";
import { formatDate, page } from "./page-layout.js";
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
  notice?: { text: string; warn?: boolean };
  /** The usage ledger is configured: show the usage tabs. */
  ledger?: boolean;
}

export function signInPage(notice?: string): string {
  const message = notice ? `<p class="notice warn">${escapeHtml(notice)}</p>` : "";
  return page(
    "multix MCP dashboard",
    `${message}<section class="card">
<h1>Manage your multix MCP account</h1>
<p>Sign in with GitHub to save the provider keys your MCP clients use and to see which clients are connected. Access is limited to invited accounts.</p>
<p><a class="btn" href="/dashboard/login">Sign in with GitHub</a></p>
</section>`,
  );
}

function clientsCard(view: DashboardView): string {
  const rows = view.clients
    .map(
      (
        c,
      ) => `<tr><td><strong>${escapeHtml(c.clientName)}</strong><br><small class="muted">Connected ${escapeHtml(formatDate(c.createdAt))}</small></td>
<td style="text-align:right"><form method="post" action="/dashboard/connections/revoke"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><input type="hidden" name="grant_id" value="${escapeHtml(c.grantId)}"><button class="btn danger small">Disconnect</button></form></td></tr>`,
    )
    .join("");
  const body = rows
    ? `<table>${rows}</table>`
    : `<p class="muted">No MCP clients are connected yet.</p>`;
  return `<section class="card"><h2>Connected MCP clients</h2>${body}</section>`;
}

export function dashboardPage(view: DashboardView): string {
  const { account } = view;
  const avatar = account.avatarUrl
    ? `<img class="avatar" src="${escapeHtml(account.avatarUrl)}" alt="">`
    : "";
  const notice = view.notice
    ? `<p class="notice${view.notice.warn ? " warn" : ""}">${escapeHtml(view.notice.text)}</p>`
    : "";
  return page(
    "multix MCP dashboard",
    `${view.ledger ? dashboardTabs("account") : ""}${notice}${view.newApiKey ? newApiKeyNotice(view.newApiKey) : ""}<section class="card">
<div class="row" style="justify-content:space-between">
<div>${avatar}<strong>${escapeHtml(account.login)}</strong></div>
<form method="post" action="/dashboard/logout"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><button class="btn secondary small" title="Ends the dashboard session on every device">Sign out</button></form>
</div>
</section>
<section class="card">
<h2>Connect an MCP client</h2>
<p>Add this remote MCP server URL in your client (Claude, Cursor, VS Code…). It opens this site to sign in and approve the connection.</p>
${copyBlock(view.mcpUrl, "MCP server URL")}
<p class="muted"><small>Claude Code:</small></p>
${copyBlock(`claude mcp add --transport http multix ${view.mcpUrl}`, "Claude Code command")}
</section>
${providerKeysCard(view.secrets, view.csrf)}
${r2SettingsCard(view.r2, view.csrf)}
${apiKeysCard(view.apiKeys, view.csrf, view.origin)}
${clientsCard(view)}`,
  );
}
