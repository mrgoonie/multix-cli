/**
 * MCP authorization consent page. Shows what the MCP spec requires: the
 * client's (unverified unless CIMD) name, where tokens go, a loopback warning,
 * and the signed-in account. Every client-supplied string is escaped.
 */

import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import type { Account } from "../accounts/account-store.js";
import { escapeHtml } from "../http-responses.js";
import { page } from "./page-layout.js";

export function consentPage(details: ConsentDescription, handle: string, account: Account): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const loopback = details.redirectIsLoopback
    ? `<p class="notice warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>`
    : "";
  const scopes =
    details.scope.length > 0
      ? `<p class="muted"><small>Scopes: <span class="mono">${details.scope.map(escapeHtml).join(", ")}</span></small></p>`
      : "";
  return page(
    `Authorize ${details.clientName}`,
    `<section class="card">
<h1>Allow ${name} to use multix?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
<p>It will be able to generate images and videos with the provider keys saved in your account, which may cost money at those providers.</p>
${scopes}
<p class="muted"><small>Signed in as <strong>${escapeHtml(account.login)}</strong>. Not you? <a href="/dashboard">Open the dashboard</a> and sign out first.</small></p>
<form method="post" class="row">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button class="btn" name="decision" value="approve">Allow</button>
<button class="btn secondary" name="decision" value="deny">Deny</button>
</form>
</section>`,
  );
}
