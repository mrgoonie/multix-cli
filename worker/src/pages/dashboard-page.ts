/**
 * Dashboard pages: the sign-in landing and the signed-in account view
 * (provider keys, connected MCP clients, connection instructions).
 * Stored key values are never rendered: only whether one is set and when.
 */

import type { Account, SecretRecords } from "../accounts/account-store.js";
import { PROVIDER_SECRET_NAMES, type ProviderSecretName } from "../config.js";
import { escapeHtml } from "../http-responses.js";
import { page } from "./page-layout.js";

const SECRET_INFO: Record<ProviderSecretName, { label: string; hint: string; secret: boolean }> = {
  REPLICATE_API_TOKEN: {
    label: "Replicate API token",
    hint: "replicate.com/account/api-tokens",
    secret: true,
  },
  ATLASCLOUD_API_KEY: { label: "Atlas Cloud API key", hint: "atlascloud.ai console", secret: true },
  HEYGEN_API_KEY: { label: "HeyGen API key", hint: "app.heygen.com/settings (API)", secret: true },
  CLOUDFLARE_ACCOUNT_ID: {
    label: "Cloudflare account ID",
    hint: "Workers AI video",
    secret: false,
  },
  CLOUDFLARE_API_TOKEN: {
    label: "Cloudflare API token",
    hint: "Workers AI permission",
    secret: true,
  },
  CLOUDFLARE_AI_GATEWAY_ID: { label: "Cloudflare AI Gateway ID", hint: "Optional", secret: false },
};

export interface ConnectedClient {
  grantId: string;
  clientName: string;
  createdAt: number;
}

export interface DashboardView {
  account: Account;
  /** Encrypted records; only their presence and `updatedAt` are rendered. */
  secrets: SecretRecords;
  csrf: string;
  mcpUrl: string;
  clients: ConnectedClient[];
  notice?: string;
}

function date(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
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

function secretRow(view: DashboardView, name: ProviderSecretName): string {
  const info = SECRET_INFO[name];
  const stored = view.secrets[name];
  const status = stored
    ? `<span class="badge ok">Saved ${escapeHtml(date(stored.updatedAt))}</span>`
    : `<span class="badge off">Not set</span>`;
  const remove = stored
    ? `<form method="post" action="/dashboard/secrets"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><input type="hidden" name="name" value="${name}"><button class="btn danger small" name="intent" value="delete">Remove</button></form>`
    : "";
  return `<div class="secret">
<div class="secret-head"><div><strong>${escapeHtml(info.label)}</strong> <span class="mono muted">${name}</span><br><small class="muted">${escapeHtml(info.hint)}</small></div><div class="row">${status}${remove}</div></div>
<form method="post" action="/dashboard/secrets" class="row" autocomplete="off">
<input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">
<input type="hidden" name="name" value="${name}">
<input type="${info.secret ? "password" : "text"}" name="value" placeholder="${stored ? "Replace the saved value" : "Paste value"}" required maxlength="1024" spellcheck="false">
<button class="btn small" name="intent" value="save">Save</button>
</form>
</div>`;
}

function clientsCard(view: DashboardView): string {
  const rows = view.clients
    .map(
      (
        c,
      ) => `<tr><td><strong>${escapeHtml(c.clientName)}</strong><br><small class="muted">Connected ${escapeHtml(date(c.createdAt))}</small></td>
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
  const notice = view.notice ? `<p class="notice">${escapeHtml(view.notice)}</p>` : "";
  return page(
    "multix MCP dashboard",
    `${notice}<section class="card">
<div class="row" style="justify-content:space-between">
<div>${avatar}<strong>${escapeHtml(account.login)}</strong></div>
<form method="post" action="/dashboard/logout"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><button class="btn secondary small">Sign out</button></form>
</div>
</section>
<section class="card">
<h2>Connect an MCP client</h2>
<p>Add this remote MCP server URL in your client (Claude, Cursor, VS Code…). It opens this site to sign in and approve the connection.</p>
<pre>${escapeHtml(view.mcpUrl)}</pre>
<p class="muted"><small>Claude Code: <span class="mono">claude mcp add --transport http multix ${escapeHtml(view.mcpUrl)}</span></small></p>
</section>
<section class="card">
<h2>Provider keys</h2>
<p class="muted"><small>Keys are encrypted at rest and used only for your own MCP requests. Saved values are never shown again. Changes can take up to a minute to reach every region.</small></p>
${PROVIDER_SECRET_NAMES.map((name) => secretRow(view, name)).join("")}
</section>
${clientsCard(view)}`,
  );
}
