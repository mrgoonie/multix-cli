/**
 * Account dashboard.
 *
 *   GET  /dashboard                       sign-in landing, or the account view
 *   GET  /dashboard/login                 start GitHub sign-in
 *   POST /dashboard/secrets               save or remove one provider key
 *   POST /dashboard/connections/revoke    disconnect one MCP client (revoke its grant)
 *   POST /dashboard/logout                end every dashboard session of the account
 *
 * Every POST needs a same-origin Origin header, a valid session and the
 * account's CSRF token. Values are validated but never echoed back.
 */

import { MAX_SECRET_CHARS, isProviderSecretName } from "../accounts/account-store.js";
import type { Account } from "../accounts/account-store.js";
import { type AppContext, oauthHelpers, sameOriginPost, signedInSession } from "../app-context.js";
import { SESSION_COOKIE, clearCookie, csrfToken, csrfValid } from "../auth/signed-cookies.js";
import { html, redirect, text } from "../http-responses.js";
import { type ConnectedClient, dashboardPage, signInPage } from "../pages/dashboard-page.js";
import { logEvent } from "../redaction.js";
import { startGithubSignIn } from "./github-sign-in-routes.js";

const NOTICES: Record<string, string> = {
  saved: "Key saved.",
  removed: "Key removed.",
  disconnected: "Client disconnected. It must sign in again to use your account.",
  invalid: "That value was not saved: it must be 1–1024 characters without spaces or line breaks.",
};

/** Printable ASCII, no whitespace: every supported provider key and id fits. */
const VALUE_RE = /^[\x21-\x7e]+$/;

async function connectedClients(ctx: AppContext, account: Account): Promise<ConnectedClient[]> {
  const oauth = oauthHelpers(ctx.env);
  const grants = await oauth.listUserGrants(account.id);
  return Promise.all(
    grants.items.map(async (grant) => {
      const client = await oauth.lookupClient(grant.clientId).catch(() => null);
      return {
        grantId: grant.id,
        clientName: client?.clientName || grant.clientId,
        createdAt: grant.createdAt * 1000,
      };
    }),
  );
}

async function showDashboard(ctx: AppContext, request: Request): Promise<Response> {
  const signedIn = await signedInSession(ctx, request);
  if (!signedIn) {
    const headers = new Headers();
    // A cookie that no longer maps to an allowed account is dropped.
    if (request.headers.get("cookie")?.includes(SESSION_COOKIE)) {
      headers.set("set-cookie", clearCookie(SESSION_COOKIE));
    }
    return html(200, signInPage(), headers);
  }
  const { account, session } = signedIn;
  const noticeKey = new URL(request.url).searchParams.get("notice") ?? "";
  return html(
    200,
    dashboardPage({
      account,
      secrets: await ctx.accounts.secrets(account.id),
      csrf: await csrfToken(ctx.sessionSecret, session),
      mcpUrl: `${ctx.origin}/mcp`,
      clients: await connectedClients(ctx, account),
      notice: NOTICES[noticeKey],
    }),
  );
}

async function handlePost(ctx: AppContext, request: Request, pathname: string): Promise<Response> {
  if (!sameOriginPost(ctx, request)) return text(403, "Forbidden");
  const signedIn = await signedInSession(ctx, request);
  if (!signedIn) return redirect("/dashboard");
  const { account, session } = signedIn;
  const form = await request.formData();
  if (!(await csrfValid(ctx.sessionSecret, session, form.get("csrf")))) {
    return text(403, "Forbidden");
  }

  if (pathname === "/dashboard/logout") {
    await ctx.accounts.endSessions(account.id);
    return redirect("/dashboard", { "set-cookie": clearCookie(SESSION_COOKIE) });
  }

  if (pathname === "/dashboard/secrets") {
    const name = String(form.get("name") ?? "");
    if (!isProviderSecretName(name)) return text(400, "Unknown provider key");
    if (form.get("intent") === "delete") {
      await ctx.accounts.deleteSecret(account.id, name);
      logEvent("info", "provider_key_removed", { user: account.id, name });
      return redirect("/dashboard?notice=removed");
    }
    const value = String(form.get("value") ?? "").trim();
    if (value.length > MAX_SECRET_CHARS || !VALUE_RE.test(value)) {
      return redirect("/dashboard?notice=invalid");
    }
    await ctx.accounts.setSecret(account.id, name, value);
    logEvent("info", "provider_key_saved", { user: account.id, name });
    return redirect("/dashboard?notice=saved");
  }

  if (pathname === "/dashboard/connections/revoke") {
    const grantId = String(form.get("grant_id") ?? "");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(grantId)) return text(400, "Invalid connection");
    // revokeGrant is scoped to the account id, so another user's grant id does nothing.
    await oauthHelpers(ctx.env).revokeGrant(grantId, account.id);
    logEvent("info", "mcp_client_disconnected", { user: account.id });
    return redirect("/dashboard?notice=disconnected");
  }

  return text(404, "Not Found");
}

export async function handleDashboard(ctx: AppContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (request.method === "GET" || request.method === "HEAD") {
    if (pathname === "/dashboard" || pathname === "/dashboard/") return showDashboard(ctx, request);
    if (pathname === "/dashboard/login") {
      return startGithubSignIn(ctx, url.searchParams.get("return_to") ?? "/dashboard");
    }
    return text(404, "Not Found");
  }
  if (request.method === "POST") return handlePost(ctx, request, pathname);
  return text(405, "Method Not Allowed", { allow: "GET, POST" });
}
