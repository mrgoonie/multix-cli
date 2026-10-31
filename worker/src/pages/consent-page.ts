/**
 * MCP authorization consent page. Shows what the MCP spec requires: the
 * client's (unverified unless CIMD) name, where tokens go, a loopback warning,
 * and the signed-in account. Every client-supplied string is escaped.
 */

import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import type { Account } from "../accounts/account-store.js";
import { escapeHtml } from "../http-responses.js";
import { messagesFor } from "./i18n.js";
import { focusPage } from "./page-layout.js";
import { DEFAULT_PREFERENCES, type Preferences } from "./preferences.js";

export function consentPage(
  details: ConsentDescription,
  handle: string,
  account: Account,
  prefs: Preferences = DEFAULT_PREFERENCES,
  here?: string,
): string {
  const c = messagesFor(prefs.lang).consent;
  const origin = details.clientDomain ? c.publishedBy(details.clientDomain) : c.unverified;
  const loopback = details.redirectIsLoopback ? `<p class="notice warn">${c.loopback}</p>` : "";
  const scopes =
    details.scope.length > 0
      ? `<p class="muted"><small>${escapeHtml(c.scopes)} <span class="mono">${details.scope.map(escapeHtml).join(", ")}</span></small></p>`
      : "";
  return focusPage(
    c.title(details.clientName),
    `<section class="panel">
<h1>${c.heading(details.clientName)}</h1>
<p>${origin} ${c.sendsTo(details.redirectHost)}</p>
${loopback}
<p>${escapeHtml(c.costs)}</p>
${scopes}
<p class="muted"><small>${c.notYou(account.login)}</small></p>
<form method="post" class="row actions">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button class="btn" name="decision" value="approve">${escapeHtml(c.allow)}</button>
<button class="btn secondary" name="decision" value="deny">${escapeHtml(c.deny)}</button>
</form>
</section>`,
    prefs,
    here,
  );
}
