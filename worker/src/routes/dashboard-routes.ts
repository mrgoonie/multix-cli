/**
 * Account dashboard.
 *
 *   GET  /dashboard                       sign-in landing, or the account view
 *   GET  /dashboard/login                 start GitHub sign-in
 *   POST /dashboard/secrets               save or remove one provider key
 *   POST /dashboard/storage               check and save, or remove, the account's R2 settings
 *   POST /dashboard/api-keys              create (shown once) or revoke a REST API key
 *   POST /dashboard/connections/revoke    disconnect one MCP client (revoke its grant)
 *   POST /dashboard/logout                end every dashboard session of the account
 *
 * Every POST needs a same-origin Origin header, a valid session and the
 * account's CSRF token. Values are validated but never echoed back.
 */

import { isProviderSecretName, isValidSecretValue } from "../accounts/account-store.js";
import type { Account } from "../accounts/account-store.js";
import { API_KEY_NAME_RE, ApiKeyStore, TooManyApiKeysError } from "../accounts/api-key-store.js";
import { r2Prefix } from "../accounts/r2-settings.js";
import { type AppContext, oauthHelpers, sameOriginPost, signedInSession } from "../app-context.js";
import { SESSION_COOKIE, clearCookie, csrfToken, csrfValid } from "../auth/signed-cookies.js";
import { html, redirect, text } from "../http-responses.js";
import type { NewApiKey } from "../pages/api-keys-card.js";
import { type ConnectedClient, dashboardPage, signInPage } from "../pages/dashboard-page.js";
import { logEvent } from "../redaction.js";
import { startGithubSignIn } from "./github-sign-in-routes.js";
import { type Notice, R2_NOTICES, handleR2SettingsPost } from "./r2-settings-routes.js";

const NOTICES: Record<string, Notice> = {
  saved: { text: "Key saved." },
  removed: { text: "Key removed." },
  disconnected: { text: "Client disconnected. It must sign in again to use your account." },
  invalid: {
    text: "That value was not saved: it must be 1–1024 characters without spaces or line breaks.",
    warn: true,
  },
  "api-key-revoked": { text: "API key revoked. It can keep working for up to a minute." },
  "api-key-not-found": {
    text: "No API key was revoked: it was not found, it may already be gone.",
    warn: true,
  },
  "api-key-invalid-name": {
    text: "API key not created: the name must be 1–64 printable characters.",
    warn: true,
  },
  "api-key-limit": {
    text: "API key not created: revoke a key first, an account can hold at most 10.",
    warn: true,
  },
  ...R2_NOTICES,
};

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

async function showDashboard(
  ctx: AppContext,
  request: Request,
  newApiKey?: NewApiKey,
): Promise<Response> {
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
  const r2 = await ctx.accounts.r2Settings(account.id);
  return html(
    200,
    dashboardPage({
      account,
      secrets: await ctx.accounts.secrets(account.id),
      r2: r2 ? { bucket: r2.bucket, publicBaseUrl: r2.publicBaseUrl, prefix: r2Prefix(r2) } : null,
      csrf: await csrfToken(ctx.sessionSecret, session),
      origin: ctx.origin,
      mcpUrl: `${ctx.origin}/mcp`,
      apiKeys: await new ApiKeyStore(ctx.env.ACCOUNTS_KV).list(account.id),
      newApiKey,
      clients: await connectedClients(ctx, account),
      notice: !newApiKey && Object.hasOwn(NOTICES, noticeKey) ? NOTICES[noticeKey] : undefined,
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
    if (!isValidSecretValue(value)) {
      return redirect("/dashboard?notice=invalid");
    }
    await ctx.accounts.setSecret(account.id, name, value);
    logEvent("info", "provider_key_saved", { user: account.id, name });
    return redirect("/dashboard?notice=saved");
  }

  if (pathname === "/dashboard/storage") return handleR2SettingsPost(ctx, account, form);

  if (pathname === "/dashboard/api-keys") {
    const store = new ApiKeyStore(ctx.env.ACCOUNTS_KV);
    if (form.get("intent") === "revoke") {
      const id = String(form.get("id") ?? "");
      const revoked = /^[A-Za-z0-9_-]{1,128}$/.test(id) && (await store.revoke(account.id, id));
      if (!revoked) return redirect("/dashboard?notice=api-key-not-found");
      logEvent("info", "api_key_revoked", { user: account.id });
      return redirect("/dashboard?notice=api-key-revoked");
    }
    const name = String(form.get("name") ?? "").trim();
    if (!API_KEY_NAME_RE.test(name)) return redirect("/dashboard?notice=api-key-invalid-name");
    try {
      const { key } = await store.create(account.id, name);
      logEvent("info", "api_key_created", { user: account.id });
      // Rendered in this response only: never stored, never put in a URL.
      return showDashboard(ctx, request, { name, key });
    } catch (error) {
      if (error instanceof TooManyApiKeysError) return redirect("/dashboard?notice=api-key-limit");
      throw error;
    }
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
