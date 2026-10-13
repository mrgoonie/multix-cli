/**
 * Dashboard card for the account's own Cloudflare R2 bucket. Only the bucket
 * name and public base URL of saved settings are shown; the access key pair is
 * never rendered, and saving always asks for the secret again.
 */

import { escapeHtml } from "../http-responses.js";

/** What the card may show about saved settings. */
export interface R2SettingsSummary {
  bucket: string;
  publicBaseUrl?: string;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

function status(summary: R2SettingsSummary | null, csrf: string): string {
  if (!summary) {
    return `<p><span class="badge off">Not configured</span> <small class="muted">File outputs of MCP jobs need a bucket; without one only text output and provider URLs are returned.</small></p>`;
  }
  const links = summary.publicBaseUrl
    ? `public URLs under <span class="mono">${escapeHtml(summary.publicBaseUrl)}</span>`
    : "presigned links valid for 7 days";
  return `<div class="row" style="justify-content:space-between;margin-bottom:12px">
<div><span class="badge ok">Configured</span> Bucket <span class="mono">${escapeHtml(summary.bucket)}</span><br><small class="muted">Outputs get ${links}.</small></div>
<form method="post" action="/dashboard/storage">${hidden("csrf", csrf)}<button class="btn danger small" name="intent" value="delete">Remove</button></form>
</div>`;
}

export function r2SettingsCard(summary: R2SettingsSummary | null, csrf: string): string {
  const action = summary ? "Check and replace" : "Check and save";
  return `<section class="card">
<h2>R2 storage</h2>
<p class="muted"><small>Your own Cloudflare R2 bucket for files your MCP jobs create. Use an R2 API token with Object Read &amp; Write on this bucket. Saving lists the bucket and writes, then deletes, an empty <span class="mono">.multix-probe</span> object; nothing is saved if a check fails. Saved credentials are encrypted and never shown again.</small></p>
${status(summary, csrf)}
<form method="post" action="/dashboard/storage" autocomplete="off">
${hidden("csrf", csrf)}
<div class="fields">
<label><small>Cloudflare account ID</small><input type="text" name="account_id" required pattern="[0-9a-fA-F]{32}" maxlength="32" spellcheck="false"></label>
<label><small>Access key ID</small><input type="text" name="access_key_id" required maxlength="128" spellcheck="false"></label>
<label><small>Secret access key</small><input type="password" name="secret_access_key" required maxlength="1024" spellcheck="false"></label>
<label><small>Bucket name</small><input type="text" name="bucket" required pattern="[a-z0-9][a-z0-9\\-]{1,61}[a-z0-9]" maxlength="63" spellcheck="false"></label>
<label><small>Public base URL (optional, https custom domain or r2.dev)</small><input type="url" name="public_base_url" maxlength="2048" placeholder="https://media.example.com" spellcheck="false"></label>
</div>
<button class="btn small" name="intent" value="save">${action}</button>
</form>
</section>`;
}
