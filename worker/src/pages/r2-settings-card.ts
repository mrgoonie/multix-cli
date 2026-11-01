/**
 * Dashboard card for the account's own output bucket: Cloudflare R2 (by
 * account id) or any S3-compatible service (by endpoint). Only the bucket,
 * endpoint host, directory, link lifetime and public base URL of saved
 * settings are shown; the access key pair is never rendered, and saving
 * always asks for the secret again.
 */

import {
  DEFAULT_R2_PREFIX,
  MAX_R2_PREFIX_CHARS,
  MIN_LINK_EXPIRY_SECONDS,
} from "../accounts/r2-settings.js";
import { escapeHtml } from "../http-responses.js";
import { MAX_PRESIGN_SECONDS } from "../storage/r2-client.js";
import type { Messages } from "./i18n.js";

/** What the card may show about saved settings. */
export interface R2SettingsSummary {
  bucket: string;
  publicBaseUrl?: string;
  /** Directory job outputs are written under. */
  prefix: string;
  /** Host of a custom S3-compatible endpoint; undefined for R2. */
  endpointHost?: string;
  /** Effective lifetime of presigned links in seconds (account choice under the operator cap). */
  linkExpirySeconds: number;
  /** The account's own saved lifetime, before the operator cap; undefined for the default. */
  savedLinkExpirySeconds?: number;
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
    : escapeHtml(t.storage.presignedLinks(summary.linkExpirySeconds));
  const where = summary.endpointHost
    ? t.storage.endpointLine(summary.endpointHost)
    : escapeHtml(t.storage.r2Line);
  return `<div class="row spread" style="margin-bottom:var(--mx-space-4)">
<div><span class="badge ok"><span class="dot" aria-hidden="true"></span>${escapeHtml(t.storage.configured)}</span> ${t.storage.bucketLine(summary.bucket, summary.prefix)}<br><small class="muted">${where} ${links}</small></div>
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
<label><small>${escapeHtml(s.accountId)}</small><input type="text" name="account_id" pattern="[0-9a-fA-F]{32}" maxlength="32" spellcheck="false"></label>
<label><small>${escapeHtml(s.endpoint)}</small><input type="url" name="endpoint" maxlength="2048" placeholder="https://s3.eu-central-1.amazonaws.com" spellcheck="false"></label>
<label><small>${escapeHtml(s.region)}</small><input type="text" name="region" maxlength="63" pattern="[a-zA-Z0-9][a-zA-Z0-9\-]{0,62}" placeholder="us-east-1" spellcheck="false"></label>
<label><small>${escapeHtml(s.addressing)}</small><select name="addressing"><option value="path">${escapeHtml(s.addressingPath)}</option><option value="virtual">${escapeHtml(s.addressingVirtual)}</option></select></label>
<label><small>${escapeHtml(s.accessKeyId)}</small><input type="text" name="access_key_id" required maxlength="128" spellcheck="false"></label>
<label><small>${escapeHtml(s.secretAccessKey)}</small><input type="password" name="secret_access_key" required maxlength="1024" spellcheck="false"></label>
<label><small>${escapeHtml(s.bucket)}</small><input type="text" name="bucket" required pattern="[a-z0-9][a-z0-9.\\-]{1,61}[a-z0-9]" maxlength="63" spellcheck="false"></label>
<label><small>${s.prefix(DEFAULT_R2_PREFIX)}</small><input type="text" name="prefix" maxlength="${MAX_R2_PREFIX_CHARS}" value="${escapeHtml(summary?.prefix ?? DEFAULT_R2_PREFIX)}" placeholder="${DEFAULT_R2_PREFIX}" spellcheck="false"></label>
<label><small>${escapeHtml(s.linkExpiry(MAX_PRESIGN_SECONDS))}</small><input type="number" name="link_expiry_seconds" min="${MIN_LINK_EXPIRY_SECONDS}" max="${MAX_PRESIGN_SECONDS}" step="1" placeholder="${MAX_PRESIGN_SECONDS}" value="${summary?.savedLinkExpirySeconds ?? ""}"></label>
<label><small>${escapeHtml(s.publicBaseUrl)}</small><input type="url" name="public_base_url" maxlength="2048" placeholder="https://media.example.com" spellcheck="false"></label>
</div>
<button class="btn small" name="intent" value="save">${escapeHtml(action)}</button>
</form>
</section>`;
}
