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
import type { Messages } from "./i18n.js";
import { formatDate } from "./page-layout.js";

/** Element id of a provider's block, the target of the overview's status links. */
export function providerAnchor(group: ProviderKeyGroup): string {
  return `provider-${group.provider.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/** Number of the group's names with a saved value. */
export function savedCount(group: ProviderKeyGroup, secrets: SecretRecords): number {
  return group.names.filter((name) => secrets[name]).length;
}

function label(
  group: ProviderKeyGroup,
  name: ProviderSecretName,
  index: number,
  t: Messages,
): string {
  const custom = t.providerKeys.labels[name];
  if (custom) return escapeHtml(custom);
  if (index === 0) return escapeHtml(t.providerKeys.apiKey);
  return t.providerKeys.alternative(group.names[0] ?? "");
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
  t: Messages,
): string {
  const stored = secrets[name];
  const status = stored
    ? `<span class="badge ok"><span class="dot" aria-hidden="true"></span>${t.providerKeys.savedAt(formatDate(stored.updatedAt))}</span>`
    : `<span class="badge off">${escapeHtml(t.providerKeys.notSet)}</span>`;
  const remove = stored
    ? `<form method="post" action="/dashboard/secrets">${hidden("csrf", csrf)}${hidden("name", name)}<button class="btn danger small" name="intent" value="delete" aria-label="${escapeHtml(`${t.providerKeys.remove} ${name}`)}">${escapeHtml(t.providerKeys.remove)}</button></form>`
    : "";
  const type = NON_SECRET_NAMES.has(name) ? "text" : "password";
  const placeholder = stored ? t.providerKeys.replace : t.providerKeys.paste;
  return `<div class="secret">
<div class="secret-head"><div><strong>${label(group, name, index, t)}</strong> <span class="mono muted">${name}</span></div><div class="row">${status}${remove}</div></div>
<form method="post" action="/dashboard/secrets" class="row" autocomplete="off">
${hidden("csrf", csrf)}${hidden("name", name)}
<input type="${type}" name="value" aria-label="${name}" placeholder="${escapeHtml(placeholder)}" required maxlength="1024" spellcheck="false">
<button class="btn small" name="intent" value="save" aria-label="${escapeHtml(`${t.providerKeys.save} ${name}`)}">${escapeHtml(t.providerKeys.save)}</button>
</form>
</div>`;
}

function groupBlock(
  group: ProviderKeyGroup,
  secrets: SecretRecords,
  csrf: string,
  t: Messages,
): string {
  const saved = savedCount(group, secrets);
  const badge =
    saved > 0
      ? `<span class="badge ok"><span class="dot" aria-hidden="true"></span>${escapeHtml(t.providerKeys.savedCount(saved))}</span>`
      : `<span class="badge off">${escapeHtml(t.providerKeys.notSet)}</span>`;
  const rows = group.names.map((name, i) => secretRow(group, name, i, secrets, csrf, t)).join("");
  return `<details class="provider" id="${providerAnchor(group)}"${saved > 0 ? " open" : ""}>
<summary><strong>${escapeHtml(group.provider)}</strong>${badge}</summary>
<p><small><a href="${escapeHtml(group.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.providerKeys.getKey)}</a></small></p>
${rows}
</details>`;
}

export function providerKeysCard(secrets: SecretRecords, csrf: string, t: Messages): string {
  return `<section class="card" id="provider-keys" aria-labelledby="provider-keys-h">
<h2 id="provider-keys-h">${escapeHtml(t.providerKeys.heading)}</h2>
<p class="card-intro">${escapeHtml(t.providerKeys.intro)}</p>
${PROVIDER_KEY_GROUPS.map((group) => groupBlock(group, secrets, csrf, t)).join("")}
</section>`;
}
