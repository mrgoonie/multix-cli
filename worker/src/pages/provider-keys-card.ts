/**
 * Dashboard card with one input per provider key env name, grouped by
 * provider. Stored values are never rendered: only whether one is saved and when.
 */

import type { SecretRecords } from "../accounts/account-store.js";
import { escapeHtml } from "../http-responses.js";
import {
  NON_SECRET_NAMES,
  PROVIDER_KEY_GROUPS,
  type ProviderKeyGroup,
  type ProviderSecretName,
} from "../provider-secret-names.js";
import { formatDate } from "./page-layout.js";

/** Labels that differ from the default "API key" / fallback wording. */
const LABELS: Partial<Record<ProviderSecretName, string>> = {
  REPLICATE_API_TOKEN: "API token",
  CLOUDFLARE_ACCOUNT_ID: "Account ID",
  CLOUDFLARE_API_TOKEN: "API token (Workers AI permission)",
  CLOUDFLARE_AI_GATEWAY_ID: "AI Gateway ID (optional)",
};

function label(group: ProviderKeyGroup, name: ProviderSecretName, index: number): string {
  const custom = LABELS[name];
  if (custom) return custom;
  if (index === 0) return "API key";
  return `Alternative name, read only when ${group.names[0]} is not set`;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

function secretRow(
  group: ProviderKeyGroup,
  name: ProviderSecretName,
  index: number,
  secrets: SecretRecords,
  csrf: string,
): string {
  const stored = secrets[name];
  const status = stored
    ? `<span class="badge ok">Saved ${escapeHtml(formatDate(stored.updatedAt))}</span>`
    : `<span class="badge off">Not set</span>`;
  const remove = stored
    ? `<form method="post" action="/dashboard/secrets">${hidden("csrf", csrf)}${hidden("name", name)}<button class="btn danger small" name="intent" value="delete">Remove</button></form>`
    : "";
  const type = NON_SECRET_NAMES.has(name) ? "text" : "password";
  return `<div class="secret">
<div class="secret-head"><div><strong>${escapeHtml(label(group, name, index))}</strong> <span class="mono muted">${name}</span></div><div class="row">${status}${remove}</div></div>
<form method="post" action="/dashboard/secrets" class="row" autocomplete="off">
${hidden("csrf", csrf)}${hidden("name", name)}
<input type="${type}" name="value" aria-label="${name}" placeholder="${stored ? "Replace the saved value" : "Paste value"}" required maxlength="1024" spellcheck="false">
<button class="btn small" name="intent" value="save">Save</button>
</form>
</div>`;
}

function groupBlock(group: ProviderKeyGroup, secrets: SecretRecords, csrf: string): string {
  const saved = group.names.filter((name) => secrets[name]).length;
  const badge =
    saved > 0
      ? `<span class="badge ok">${saved} saved</span>`
      : `<span class="badge off">Not set</span>`;
  const rows = group.names.map((name, i) => secretRow(group, name, i, secrets, csrf)).join("");
  return `<details class="provider"${saved > 0 ? " open" : ""}>
<summary><strong>${escapeHtml(group.provider)}</strong>${badge}</summary>
<p><small><a href="${escapeHtml(group.link)}" target="_blank" rel="noopener noreferrer">Get a key</a></small></p>
${rows}
</details>`;
}

export function providerKeysCard(secrets: SecretRecords, csrf: string): string {
  return `<section class="card">
<h2>Provider keys</h2>
<p class="muted"><small>Keys are encrypted at rest and used only for your own MCP requests. Saved values are never shown again. Changes can take up to a minute to reach every region.</small></p>
${PROVIDER_KEY_GROUPS.map((group) => groupBlock(group, secrets, csrf)).join("")}
</section>`;
}
