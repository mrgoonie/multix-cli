/**
 * Dashboard card for REST API keys: create, list (name, prefix, creation
 * time) and revoke. A new key is rendered once, in the response to the
 * create request, and is never stored or shown again.
 */

import type { ApiKeyRecord } from "../accounts/api-key-store.js";
import { MAX_API_KEYS_PER_ACCOUNT } from "../accounts/api-key-store.js";
import { escapeHtml } from "../http-responses.js";
import { copyField } from "./copy-button.js";
import type { Lang, Messages } from "./i18n.js";
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
export function newApiKeyNotice(created: NewApiKey, t: Messages, lang: Lang): string {
  return `<section class="card" id="new-api-key" aria-labelledby="new-api-key-h">
<h2 id="new-api-key-h">${t.apiKeys.newHeading(created.name)}</h2>
<p>${escapeHtml(t.apiKeys.newBody)}</p>
${copyField(created.key, t.apiKeys.newLabel, "new-api-key-value", lang)}
</section>`;
}

export function apiKeysCard(
  keys: ApiKeyRecord[],
  csrf: string,
  origin: string,
  t: Messages,
): string {
  const a = t.apiKeys;
  const rows = keys
    .map(
      (
        k,
      ) => `<tr><td><strong>${escapeHtml(k.name)}</strong> <span class="mono muted">${escapeHtml(k.prefix)}…</span><br><small class="muted">${a.created(formatDate(k.createdAt))}</small></td>
<td class="end"><form method="post" action="/dashboard/api-keys">${hidden("csrf", csrf)}${hidden("id", k.id)}<button class="btn danger small" name="intent" value="revoke" aria-label="${escapeHtml(`${a.revoke} ${k.name}`)}">${escapeHtml(a.revoke)}</button></form></td></tr>`,
    )
    .join("");
  const list = rows ? `<table>${rows}</table>` : `<p class="muted">${escapeHtml(a.none)}</p>`;
  const create =
    keys.length < MAX_API_KEYS_PER_ACCOUNT
      ? `<form method="post" action="/dashboard/api-keys" class="row" autocomplete="off" style="margin-top:var(--mx-space-4)">
${hidden("csrf", csrf)}
<input type="text" name="name" required maxlength="64" placeholder="${escapeHtml(a.namePlaceholder)}" aria-label="${escapeHtml(a.nameLabel)}" spellcheck="false">
<button class="btn small" name="intent" value="create">${escapeHtml(a.create)}</button>
</form>`
      : `<p class="muted"><small>${escapeHtml(a.limit(MAX_API_KEYS_PER_ACCOUNT))}</small></p>`;
  return `<section class="card" id="api-keys" aria-labelledby="api-keys-h">
<h2 id="api-keys-h">${escapeHtml(a.heading)}</h2>
<p class="card-intro">${a.intro(origin)}</p>
${list}
${create}
</section>`;
}
