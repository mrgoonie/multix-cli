/**
 * Dashboard card for REST API keys: create, list (name, prefix, creation
 * time) and revoke. A new key is rendered once, in the response to the
 * create request, and is never stored or shown again.
 */

import type { ApiKeyRecord } from "../accounts/api-key-store.js";
import { MAX_API_KEYS_PER_ACCOUNT } from "../accounts/api-key-store.js";
import { escapeHtml } from "../http-responses.js";
import { copyField } from "./copy-button.js";
import { formatDate } from "./page-layout.js";

/** A key created by this request, shown once. */
export interface NewApiKey {
  name: string;
  key: string;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

/** The one-time display of a new key, placed at the top of the page. */
export function newApiKeyNotice(created: NewApiKey): string {
  return `<section class="card" id="new-api-key">
<h2>API key created: ${escapeHtml(created.name)}</h2>
<p>Copy it now. It is shown only once; if you lose it, revoke it and create another. Do not reload this page: that sends the form again and creates another key.</p>
${copyField(created.key, "New API key", "new-api-key-value")}
</section>`;
}

export function apiKeysCard(keys: ApiKeyRecord[], csrf: string, origin: string): string {
  const rows = keys
    .map(
      (
        k,
      ) => `<tr><td><strong>${escapeHtml(k.name)}</strong> <span class="mono muted">${escapeHtml(k.prefix)}…</span><br><small class="muted">Created ${escapeHtml(formatDate(k.createdAt))}</small></td>
<td style="text-align:right"><form method="post" action="/dashboard/api-keys">${hidden("csrf", csrf)}${hidden("id", k.id)}<button class="btn danger small" name="intent" value="revoke">Revoke</button></form></td></tr>`,
    )
    .join("");
  const list = rows ? `<table>${rows}</table>` : `<p class="muted">No API keys yet.</p>`;
  const create =
    keys.length < MAX_API_KEYS_PER_ACCOUNT
      ? `<form method="post" action="/dashboard/api-keys" class="row" autocomplete="off" style="margin-top:12px">
${hidden("csrf", csrf)}
<input type="text" name="name" required maxlength="64" placeholder="Key name, e.g. laptop or CI" spellcheck="false">
<button class="btn small" name="intent" value="create">Create API key</button>
</form>`
      : `<p class="muted"><small>You have the maximum of ${MAX_API_KEYS_PER_ACCOUNT} keys; revoke one to create another.</small></p>`;
  return `<section class="card">
<h2>API keys</h2>
<p class="muted"><small>For the REST API (<a href="/api/docs">reference</a>, base URL <span class="mono">${escapeHtml(origin)}/api/v1</span>). A key acts as your account: it can change provider keys and storage and run jobs. Only a hash is stored. A revoked key can keep working for up to a minute.</small></p>
${list}
${create}
</section>`;
}
