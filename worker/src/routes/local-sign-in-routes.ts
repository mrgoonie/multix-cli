/**
 * Local sign-in (only when MULTIX_LOCAL_AUTH=true; see accounts/local-auth.ts).
 *
 *   GET  /dashboard/login?return_to=…         username/password form (+ GitHub link when configured)
 *   POST /dashboard/login                     check the password, start a dashboard session
 *   GET  /dashboard/setup                     one-time form for the bootstrap admin
 *   POST /dashboard/setup                     check the bootstrap token, create the admin, sign in
 *
 * Every failed sign-in gets the same message whether the username exists or
 * not, and an unknown username still costs one PBKDF2 derivation. Passwords,
 * tokens and usernames of failed attempts are never logged. The routes sit
 * under /dashboard, so AUTH_RATE_LIMITER (per IP) covers them.
 */

import {
  MAX_PASSWORD_CHARS,
  bootstrapTokenValid,
  hashPassword,
  isAcceptablePassword,
  isBootstrapDone,
  markBootstrapDone,
  newLocalAccountId,
  normalizeUsername,
  readLocalCredential,
  verifyPassword,
  writeLocalCredential,
} from "../accounts/local-auth.js";
import { type AppContext, sameOriginPost } from "../app-context.js";
import { sessionCookie } from "../auth/signed-cookies.js";
import { html, redirect, text } from "../http-responses.js";
import { messagesFor } from "../pages/i18n.js";
import { localLoginPage, setupPage } from "../pages/local-auth-pages.js";
import { resolvePreferences, withPreferenceCookies } from "../pages/preferences.js";
import { logEvent } from "../redaction.js";
import { safeReturnTo } from "./github-sign-in-routes.js";

export const LOCAL_LOGIN_PATH = "/dashboard/login";
export const SETUP_PATH = "/dashboard/setup";

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

async function renderLogin(
  ctx: AppContext,
  request: Request,
  status: number,
  returnTo: string,
  extra: { username?: string; error?: string } = {},
  headers?: Headers,
): Promise<Response> {
  const preferences = resolvePreferences(request);
  const setupOpen = !(await isBootstrapDone(ctx.env.ACCOUNTS_KV));
  return html(
    status,
    localLoginPage({
      prefs: preferences.prefs,
      returnTo: safeReturnTo(returnTo),
      githubEnabled: ctx.githubEnabled,
      setupOpen,
      ...extra,
    }),
    headers ?? withPreferenceCookies(preferences),
  );
}

/**
 * The sign-in form; also the signed-out /dashboard landing when local sign-in
 * is on (`headers` then carries that page's preference and cookie changes).
 */
export function showLocalLogin(
  ctx: AppContext,
  request: Request,
  returnTo: string | null,
  headers?: Headers,
): Promise<Response> {
  return renderLogin(ctx, request, 200, safeReturnTo(returnTo), {}, headers);
}

export async function finishLocalLogin(ctx: AppContext, request: Request): Promise<Response> {
  if (!sameOriginPost(ctx, request)) return text(403, "Forbidden");
  const form = await request.formData();
  const returnTo = safeReturnTo(field(form, "return_to"));
  const rawUsername = field(form, "username");
  const password = field(form, "password");
  const username = normalizeUsername(rawUsername);

  const credential =
    username && password.length <= MAX_PASSWORD_CHARS
      ? await readLocalCredential(ctx.env.ACCOUNTS_KV, username)
      : null;
  const passwordOk = await verifyPassword(credential, password.slice(0, MAX_PASSWORD_CHARS));
  const account = passwordOk && credential ? await ctx.accounts.get(credential.accountId) : null;
  if (!username || !credential || !account || !passwordOk) {
    logEvent("warn", "local_sign_in_failed", {});
    const m = messagesFor(resolvePreferences(request).prefs.lang).localAuth;
    return renderLogin(ctx, request, 401, returnTo, {
      username: rawUsername.trim().slice(0, 32),
      error: m.invalidCredentials,
    });
  }
  await ctx.accounts.upsertLocal(account.id, username);
  logEvent("info", "local_sign_in", { user: account.id });
  return redirect(returnTo, { "set-cookie": await sessionCookie(ctx.sessionSecret, account.id) });
}

export async function showSetup(ctx: AppContext, request: Request): Promise<Response> {
  if (await isBootstrapDone(ctx.env.ACCOUNTS_KV)) return text(404, "Not Found");
  const preferences = resolvePreferences(request);
  return html(200, setupPage({ prefs: preferences.prefs }), withPreferenceCookies(preferences));
}

export async function finishSetup(ctx: AppContext, request: Request): Promise<Response> {
  if (!sameOriginPost(ctx, request)) return text(403, "Forbidden");
  const kv = ctx.env.ACCOUNTS_KV;
  if (await isBootstrapDone(kv)) return text(404, "Not Found");
  const form = await request.formData();
  const preferences = resolvePreferences(request);
  const m = messagesFor(preferences.prefs.lang).localAuth;
  const rawUsername = field(form, "username");
  const reject = (status: number, error: string) =>
    html(
      status,
      setupPage({ prefs: preferences.prefs, username: rawUsername.trim().slice(0, 32), error }),
      withPreferenceCookies(preferences),
    );

  if (!(await bootstrapTokenValid(ctx.env, kv, field(form, "token")))) {
    logEvent("warn", "bootstrap_token_rejected", {});
    return reject(403, m.badToken);
  }
  const username = normalizeUsername(rawUsername);
  if (!username) return reject(400, m.badUsername);
  const password = field(form, "password");
  if (!isAcceptablePassword(password)) return reject(400, m.badPassword);
  if (password !== field(form, "confirm")) return reject(400, m.passwordMismatch);

  const accountId = newLocalAccountId();
  const credential = await hashPassword(password, accountId);
  // KV has no transactions: re-check right before writing (see local-auth.ts).
  if (await isBootstrapDone(kv)) return text(404, "Not Found");
  const account = await ctx.accounts.upsertLocal(accountId, username);
  await writeLocalCredential(kv, username, credential);
  await markBootstrapDone(kv, account.id);
  logEvent("info", "bootstrap_admin_created", { user: account.id });
  return redirect("/dashboard", {
    "set-cookie": await sessionCookie(ctx.sessionSecret, account.id),
  });
}
