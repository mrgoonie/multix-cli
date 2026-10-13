/**
 * GitHub sign-in for the dashboard and for the MCP consent page.
 *
 *   GET /dashboard/login?return_to=…   start: PKCE + state in a signed, short-lived cookie
 *   GET /oauth/github/callback         finish: check state, read identity, enforce the allowlist
 *
 * `return_to` is limited to /dashboard and /oauth/authorize?… so the round
 * trip cannot be turned into an open redirect.
 */

import { isAllowed } from "../accounts/allowlist.js";
import { randomBase64Url } from "../accounts/base64.js";
import type { AppContext } from "../app-context.js";
import {
  GithubSignInError,
  fetchGithubIdentity,
  githubAuthorizeUrl,
  pkceChallenge,
} from "../auth/github-oauth-client.js";
import {
  LOGIN_COOKIE,
  LOGIN_TTL_SECONDS,
  clearCookie,
  readCookie,
  sessionCookie,
  setCookie,
  sign,
  verify,
} from "../auth/signed-cookies.js";
import { tokensMatch } from "../http-guards.js";
import { html, redirect } from "../http-responses.js";
import { messagePage } from "../pages/page-layout.js";
import { logEvent } from "../redaction.js";

export const GITHUB_CALLBACK_PATH = "/oauth/github/callback";

interface LoginState {
  state: string;
  verifier: string;
  returnTo: string;
}

/** Only same-site paths we own; anything else falls back to the dashboard. */
export function safeReturnTo(value: string | null): string {
  if (!value) return "/dashboard";
  if (value === "/dashboard" || value.startsWith("/oauth/authorize?")) return value;
  return "/dashboard";
}

export async function startGithubSignIn(ctx: AppContext, returnTo: string): Promise<Response> {
  const login: LoginState = {
    state: randomBase64Url(24),
    verifier: randomBase64Url(32),
    returnTo: safeReturnTo(returnTo),
  };
  const cookie = await sign(ctx.sessionSecret, "login", login, LOGIN_TTL_SECONDS);
  const location = githubAuthorizeUrl({
    clientId: ctx.githubClientId,
    redirectUri: `${ctx.origin}${GITHUB_CALLBACK_PATH}`,
    state: login.state,
    codeChallenge: await pkceChallenge(login.verifier),
  });
  return redirect(
    location,
    { "set-cookie": setCookie(LOGIN_COOKIE, cookie, LOGIN_TTL_SECONDS) },
    302,
  );
}

function failure(status: number, title: string, message: string): Response {
  const headers = new Headers({ "set-cookie": clearCookie(LOGIN_COOKIE) });
  return html(
    status,
    messagePage(title, message, { href: "/dashboard", label: "Back to the dashboard" }),
    headers,
  );
}

export async function finishGithubSignIn(ctx: AppContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const login = await verify<LoginState>(
    ctx.sessionSecret,
    "login",
    readCookie(request, LOGIN_COOKIE),
  );
  const state = url.searchParams.get("state") ?? "";
  if (!login || !state || !(await tokensMatch(state, login.state))) {
    return failure(
      400,
      "Sign-in expired",
      "This sign-in link expired or was opened in another browser. Please start again.",
    );
  }
  if (url.searchParams.get("error")) {
    return failure(400, "Sign-in cancelled", "GitHub sign-in was cancelled.");
  }
  const code = url.searchParams.get("code");
  if (!code) return failure(400, "Sign-in failed", "GitHub did not return an authorization code.");

  let identity: Awaited<ReturnType<typeof fetchGithubIdentity>>;
  try {
    identity = await fetchGithubIdentity(ctx.fetch, {
      clientId: ctx.githubClientId,
      clientSecret: ctx.githubClientSecret,
      code,
      redirectUri: `${ctx.origin}${GITHUB_CALLBACK_PATH}`,
      codeVerifier: login.verifier,
    });
  } catch (error) {
    logEvent("warn", "github_sign_in_failed", {
      error: error instanceof GithubSignInError ? error.message : "unexpected",
    });
    return failure(
      502,
      "Sign-in failed",
      "GitHub sign-in could not be completed. Please try again.",
    );
  }

  if (!isAllowed(ctx.env.MULTIX_ALLOWED_USERS, identity)) {
    logEvent("warn", "sign_in_denied", { github_id: identity.githubId });
    return failure(
      403,
      "Not invited",
      `The GitHub account ${identity.login} is not on this server's access list.`,
    );
  }
  const account = await ctx.accounts.upsertFromGithub(identity);
  logEvent("info", "sign_in", { user: account.id });
  const headers = new Headers();
  headers.append("set-cookie", clearCookie(LOGIN_COOKIE));
  headers.append("set-cookie", await sessionCookie(ctx.sessionSecret, { userId: account.id }));
  return redirect(safeReturnTo(login.returnTo), headers);
}
