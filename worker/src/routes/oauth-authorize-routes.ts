/**
 * The OAuth authorization endpoint for MCP clients (/oauth/authorize).
 *
 * GET: validate the request, require a signed-in, allowlisted account (else
 * send the browser through GitHub sign-in and back), then show the consent
 * page. POST: the consent form; on Allow, issue the grant with the account id
 * in `props` so /mcp can load that account's own provider keys.
 *
 * Error handling follows the library's consent-page guide: redirect to the
 * client only when the library says the redirect URI is validated.
 */

import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { type AppContext, oauthHelpers, sameOriginPost, signedInAccount } from "../app-context.js";
import { html, redirect, text } from "../http-responses.js";
import { consentPage } from "../pages/consent-page.js";
import { messagesFor } from "../pages/i18n.js";
import { messagePage } from "../pages/page-layout.js";
import { resolvePreferences, selfPath, withPreferenceCookies } from "../pages/preferences.js";
import { logEvent } from "../redaction.js";

export const AUTHORIZE_PATH = "/oauth/authorize";
/** The one OAuth scope: full use of the MCP tools with the account's own keys. */
export const MCP_SCOPE = "mcp";

/** What the MCP handler receives in ctx.props. */
export interface GrantProps {
  userId: string;
}

function authorizationFailure(error: unknown, request: Request): Response {
  if (error instanceof AuthorizationError && error.redirectTo) {
    return redirect(error.redirectTo, {}, 302);
  }
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    const preferences = resolvePreferences(request);
    const m = messagesFor(preferences.prefs.lang).messages;
    // The library's description is protocol detail and stays in English.
    const message = error instanceof AuthorizationError ? error.description : m.unverifiedApp;
    return html(
      400,
      messagePage(m.authorizationFailed, message, undefined, preferences.prefs),
      withPreferenceCookies(preferences),
    );
  }
  throw error;
}

export async function handleAuthorize(ctx: AppContext, request: Request): Promise<Response> {
  const oauth = oauthHelpers(ctx.env);
  const preferences = resolvePreferences(request);
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const account = await signedInAccount(ctx, request);
      if (!account) {
        const url = new URL(request.url);
        const returnTo = `${url.pathname}${url.search}`;
        return redirect(`/dashboard/login?return_to=${encodeURIComponent(returnTo)}`, {}, 302);
      }
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return html(
        200,
        consentPage(details, consent.handle, account, preferences.prefs, selfPath(request)),
        withPreferenceCookies(preferences, consent.headers),
      );
    }

    if (request.method === "POST") {
      if (!sameOriginPost(ctx, request)) return text(403, "Forbidden");
      const account = await signedInAccount(ctx, request);
      if (!account) {
        const m = messagesFor(preferences.prefs.lang).messages;
        return html(401, messagePage(m.signedOut, m.signedOutBody, undefined, preferences.prefs));
      }
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle);
      const props: GrantProps = { userId: account.id };
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: account.id,
        metadata: { login: account.login },
        // Grant exactly the scope /mcp requires, whatever the client asked for.
        scope: [MCP_SCOPE],
        props,
      });
      logEvent("info", "mcp_client_authorized", { user: account.id });
      approved.headers.set("location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }

    return text(405, "Method Not Allowed", { allow: "GET, POST" });
  } catch (error) {
    return authorizationFailure(error, request);
  }
}
