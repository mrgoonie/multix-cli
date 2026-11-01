/**
 * Local sign-in pages: the username/password form and the one-time setup
 * form that creates the bootstrap admin. Both post to their own URL; the CSP
 * has no form-action, so same-origin form posts work. Passwords and the
 * bootstrap token are never rendered back.
 */

import { escapeHtml } from "../http-responses.js";
import { messagesFor } from "./i18n.js";
import { focusPage } from "./page-layout.js";
import type { Preferences } from "./preferences.js";

export interface LocalLoginView {
  prefs: Preferences;
  /** Already passed through safeReturnTo. */
  returnTo: string;
  /** Show the "Sign in with GitHub" link. */
  githubEnabled: boolean;
  /** Link to /dashboard/setup (no admin yet). */
  setupOpen: boolean;
  /** Pre-fills the username after a failed attempt. */
  username?: string;
  error?: string;
}

function loginHref(path: string, returnTo: string): string {
  return returnTo === "/dashboard" ? path : `${path}?return_to=${encodeURIComponent(returnTo)}`;
}

function errorNotice(error: string | undefined): string {
  return error ? `<p class="notice warn" role="alert">${escapeHtml(error)}</p>` : "";
}

export function localLoginPage(view: LocalLoginView): string {
  const t = messagesFor(view.prefs.lang);
  const l = t.localAuth;
  const github = view.githubEnabled
    ? `<p class="actions"><a class="btn secondary" href="${escapeHtml(loginHref("/dashboard/login/github", view.returnTo))}">${escapeHtml(l.withGithub)}</a></p>`
    : "";
  const setup = view.setupOpen
    ? `<p class="muted">${escapeHtml(l.needsSetup)} <a href="/dashboard/setup">${escapeHtml(l.setupLink)}</a></p>`
    : "";
  return focusPage(
    l.loginTitle,
    `<section class="panel">
<p class="eyebrow">${escapeHtml(t.tagline)}</p>
<h1>${escapeHtml(l.loginHeading)}</h1>
<p class="muted">${escapeHtml(l.loginBody)}</p>
${errorNotice(view.error)}
<form method="post" action="/dashboard/login">
<input type="hidden" name="return_to" value="${escapeHtml(view.returnTo)}">
<div class="fields">
<label>${escapeHtml(l.username)}<input type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="32" value="${escapeHtml(view.username ?? "")}"></label>
<label>${escapeHtml(l.password)}<input type="password" name="password" autocomplete="current-password" required maxlength="256"></label>
</div>
<p class="actions"><button class="btn">${escapeHtml(l.signIn)}</button></p>
</form>
${github}
${setup}
</section>`,
    view.prefs,
    loginHref("/dashboard/login", view.returnTo),
  );
}

export interface SetupView {
  prefs: Preferences;
  /** Pre-fills the username after a rejected attempt. */
  username?: string;
  error?: string;
}

export function setupPage(view: SetupView): string {
  const l = messagesFor(view.prefs.lang).localAuth;
  return focusPage(
    l.setupTitle,
    `<section class="panel">
<h1>${escapeHtml(l.setupTitle)}</h1>
<p class="muted">${escapeHtml(l.setupBody)}</p>
${errorNotice(view.error)}
<form method="post" action="/dashboard/setup">
<div class="fields">
<label>${escapeHtml(l.bootstrapToken)}<input type="password" name="token" autocomplete="off" required></label>
<label>${escapeHtml(l.username)}<input type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9._\\-]{2,31}" value="${escapeHtml(view.username ?? "")}"><small>${escapeHtml(l.usernameHint)}</small></label>
<label>${escapeHtml(l.password)}<input type="password" name="password" autocomplete="new-password" required minlength="12" maxlength="256"><small>${escapeHtml(l.passwordHint)}</small></label>
<label>${escapeHtml(l.confirmPassword)}<input type="password" name="confirm" autocomplete="new-password" required minlength="12" maxlength="256"></label>
</div>
<p class="actions"><button class="btn">${escapeHtml(l.createAdmin)}</button></p>
</form>
</section>`,
    view.prefs,
    "/dashboard/setup",
  );
}
