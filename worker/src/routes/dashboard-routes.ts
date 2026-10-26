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
 *   … /dashboard/{overview,usage,budgets,traces,activity}  usage ledger pages (finops-dashboard-routes.ts)
 *
 * Every POST needs a same-origin Origin header, a valid session and the
 * account's CSRF token. Values are validated but never echoed back.
 * Account changes are appended to the account's activity log (actor
 * `user:<id>`) with names and ids only, never key values or URLs.
 */

import { isProviderSecretName, isValidSecretValue } from "../accounts/account-store.js";
import type { Account } from "../accounts/account-store.js";
import { API_KEY_NAME_RE, ApiKeyStore, TooManyApiKeysError } from "../accounts/api-key-store.js";
import { r2Prefix } from "../accounts/r2-settings.js";
import {
  type AppContext,
  type AppDeps,
  ledgerFor,
  oauthHelpers,
  recordActivity,
  sameOriginPost,
  signedInSession,
} from "../app-context.js";
import { SESSION_COOKIE, clearCookie, csrfToken, csrfValid } from "../auth/signed-cookies.js";
import { html, redirect, text } from "../http-responses.js";
import type { NewApiKey } from "../pages/api-keys-card.js";
import { type ConnectedClient, dashboardPage, signInPage } from "../pages/dashboard-page.js";
import { logEvent } from "../redaction.js";
import { handleFinopsGet, handleFinopsPost, isFinopsPath } from "./finops-dashboard-routes.js";
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

/** The parts of an OAuth grant summary the revoke needs. */
interface Grant {
  id: string;
  clientId: string;
}

/**
 * A disconnected client's MCP Events subscriptions go with it, unless the
 * account keeps another grant for the same client. Runs before the grant is
 * revoked: if it fails, the connection is still listed and can be retried.
 */
async function removeClientSubscriptions(
  ctx: AppContext,
  deps: AppDeps,
  userId: string,
  grants: Grant[],
  revoked: Grant,
): Promise<number> {
  const events = deps.events ?? ctx.env.MULTIX_EVENTS;
  if (!events) return 0;
  if (grants.some((g) => g.clientId === revoked.clientId && g.id !== revoked.id)) return 0;
  return events.getByName(userId).removeByClient(revoked.clientId, `dashboard:${userId}`);
}

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
  deps: AppDeps,
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
      ledger: ledgerFor(ctx.env, deps, account.id) !== undefined,
    }),
  );
}

async function handlePost(
  ctx: AppContext,
  deps: AppDeps,
  request: Request,
  pathname: string,
): Promise<Response> {
  if (!sameOriginPost(ctx, request)) return text(403, "Forbidden");
  const signedIn = await signedInSession(ctx, request);
  if (!signedIn) return redirect("/dashboard");
  const { account, session } = signedIn;
  const form = await request.formData();
  if (!(await csrfValid(ctx.sessionSecret, session, form.get("csrf")))) {
    return text(403, "Forbidden");
  }
  if (isFinopsPath(pathname)) return handleFinopsPost(ctx, deps, signedIn, form, pathname);
  const actor = `user:${account.id}`;
  const activity = (kind: string, subject: string | null, metadata = {}) =>
    recordActivity(ctx.env, deps, account.id, { actor, kind, subject, metadata });

  if (pathname === "/dashboard/logout") {
    await ctx.accounts.endSessions(account.id);
    await activity("auth.signed_out", null);
    return redirect("/dashboard", { "set-cookie": clearCookie(SESSION_COOKIE) });
  }

  if (pathname === "/dashboard/secrets") {
    const name = String(form.get("name") ?? "");
    if (!isProviderSecretName(name)) return text(400, "Unknown provider key");
    if (form.get("intent") === "delete") {
      await ctx.accounts.deleteSecret(account.id, name);
      logEvent("info", "provider_key_removed", { user: account.id, name });
      await activity("provider_key.removed", name);
      return redirect("/dashboard?notice=removed");
    }
    const value = String(form.get("value") ?? "").trim();
    if (!isValidSecretValue(value)) {
      return redirect("/dashboard?notice=invalid");
    }
    await ctx.accounts.setSecret(account.id, name, value);
    logEvent("info", "provider_key_saved", { user: account.id, name });
    await activity("provider_key.saved", name);
    return redirect("/dashboard?notice=saved");
  }

  if (pathname === "/dashboard/storage") return handleR2SettingsPost(ctx, account, form, deps);

  if (pathname === "/dashboard/api-keys") {
    const store = new ApiKeyStore(ctx.env.ACCOUNTS_KV);
    if (form.get("intent") === "revoke") {
      const id = String(form.get("id") ?? "");
      const revoked = /^[A-Za-z0-9_-]{1,128}$/.test(id) && (await store.revoke(account.id, id));
      if (!revoked) return redirect("/dashboard?notice=api-key-not-found");
      logEvent("info", "api_key_revoked", { user: account.id });
      await activity("api_key.revoked", id);
      return redirect("/dashboard?notice=api-key-revoked");
    }
    const name = String(form.get("name") ?? "").trim();
    if (!API_KEY_NAME_RE.test(name)) return redirect("/dashboard?notice=api-key-invalid-name");
    try {
      const { key, record } = await store.create(account.id, name);
      logEvent("info", "api_key_created", { user: account.id });
      await activity("api_key.created", record.id, { name });
      // Rendered in this response only: never stored, never put in a URL.
      return showDashboard(ctx, deps, request, { name, key });
    } catch (error) {
      if (error instanceof TooManyApiKeysError) return redirect("/dashboard?notice=api-key-limit");
      throw error;
    }
  }

  if (pathname === "/dashboard/connections/revoke") {
    const grantId = String(form.get("grant_id") ?? "");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(grantId)) return text(400, "Invalid connection");
    const oauth = oauthHelpers(ctx.env);
    const grants = (await oauth.listUserGrants(account.id)).items;
    const grant = grants.find((g) => g.id === grantId);
    const removed = grant
      ? await removeClientSubscriptions(ctx, deps, account.id, grants, grant)
      : 0;
    // revokeGrant is scoped to the account id, so another user's grant id does nothing.
    await oauth.revokeGrant(grantId, account.id);
    logEvent("info", "mcp_client_disconnected", { user: account.id, subscriptions: removed });
    if (grant) {
      const client = await oauth.lookupClient(grant.clientId).catch(() => null);
      await activity("mcp_client.disconnected", grant.clientId, {
        client_name: client?.clientName ?? null,
      });
    }
    return redirect("/dashboard?notice=disconnected");
  }

  return text(404, "Not Found");
}

export async function handleDashboard(
  ctx: AppContext,
  request: Request,
  deps: AppDeps = {},
): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (request.method === "GET" || request.method === "HEAD") {
    if (pathname === "/dashboard" || pathname === "/dashboard/") {
      return showDashboard(ctx, deps, request);
    }
    if (isFinopsPath(pathname)) return handleFinopsGet(ctx, deps, request);
    if (pathname === "/dashboard/login") {
      return startGithubSignIn(ctx, url.searchParams.get("return_to") ?? "/dashboard");
    }
    return text(404, "Not Found");
  }
  if (request.method === "POST") return handlePost(ctx, deps, request, pathname);
  return text(405, "Method Not Allowed", { allow: "GET, POST" });
}
