/**
 * Dashboard card for the account's own Cloudflare R2 bucket. Only the bucket
 * name and public base URL of saved settings are shown; the access key pair is
 * never rendered, and saving always asks for the secret again.
 */

import { DEFAULT_R2_PREFIX, MAX_R2_PREFIX_CHARS } from "../accounts/r2-settings.js";
import { escapeHtml } from "../http-responses.js";
import type { Messages } from "./i18n.js";

/** What the card may show about saved settings. */
export interface R2SettingsSummary {
  bucket: string;
  publicBaseUrl?: string;
  /** Directory job outputs are written under. */
  prefix: string;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

function status(summary: R2SettingsSummary | null, csrf: string, t: Messages): string {
  if (!summary) {
    return `<p><span class="badge off">${escapeHtml(t.storage.notConfigured)}</span> <small class="muted">${escapeHtml(t.storage.notConfiguredBody)}</small></p>`;
  }
  const links = summary.publicBaseUrl
    ? t.storage.publicLinks(summary.publicBaseUrl)
    : escapeHtml(t.storage.presignedLinks);
  return `<div class="row spread" style="margin-bottom:var(--mx-space-4)">
<div><span class="badge ok"><span class="dot" aria-hidden="true"></span>${escapeHtml(t.storage.configured)}</span> ${t.storage.bucketLine(summary.bucket, summary.prefix)}<br><small class="muted">${links}</small></div>
<form method="post" action="/dashboard/storage">${hidden("csrf", csrf)}<button class="btn danger small" name="intent" value="delete">${escapeHtml(t.storage.remove)}</button></form>
</div>`;
}

export function r2SettingsCard(
  summary: R2SettingsSummary | null,
  csrf: string,
  t: Messages,
): string {
  const s = t.storage;
  const action = summary ? s.checkAndReplace : s.checkAndSave;
  return `<section class="card" id="storage" aria-labelledby="storage-h">
<h2 id="storage-h">${escapeHtml(s.heading)}</h2>
<p class="card-intro">${s.intro}</p>
${status(summary, csrf, t)}
<form method="post" action="/dashboard/storage" autocomplete="off">
${hidden("csrf", csrf)}
<div class="fields">
<label><small>${escapeHtml(s.accountId)}</small><input type="text" name="account_id" required pattern="[0-9a-fA-F]{32}" maxlength="32" spellcheck="false"></label>
<label><small>${escapeHtml(s.accessKeyId)}</small><input type="text" name="access_key_id" required maxlength="128" spellcheck="false"></label>
<label><small>${escapeHtml(s.secretAccessKey)}</small><input type="password" name="secret_access_key" required maxlength="1024" spellcheck="false"></label>
<label><small>${escapeHtml(s.bucket)}</small><input type="text" name="bucket" required pattern="[a-z0-9][a-z0-9\\-]{1,61}[a-z0-9]" maxlength="63" spellcheck="false"></label>
<label><small>${s.prefix(DEFAULT_R2_PREFIX)}</small><input type="text" name="prefix" maxlength="${MAX_R2_PREFIX_CHARS}" value="${escapeHtml(summary?.prefix ?? DEFAULT_R2_PREFIX)}" placeholder="${DEFAULT_R2_PREFIX}" spellcheck="false"></label>
<label><small>${escapeHtml(s.publicBaseUrl)}</small><input type="url" name="public_base_url" maxlength="2048" placeholder="https://media.example.com" spellcheck="false"></label>
</div>
<button class="btn small" name="intent" value="save">${escapeHtml(action)}</button>
</form>
</section>`;
}
