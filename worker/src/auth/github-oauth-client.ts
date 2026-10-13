/**
 * GitHub OAuth App sign-in: authorize URL, code exchange (with PKCE) and the
 * identity lookup. The GitHub access token is used only to read the user's
 * profile and verified emails, then discarded; it is never stored.
 */

import type { FetchLike } from "../../../src/core/fetch-json.js";
import type { GithubIdentity } from "../accounts/account-store.js";
import { bytesToBase64Url } from "../accounts/base64.js";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";
const USER_AGENT = "multix-mcp";

export class GithubSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubSignInError";
  }
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function githubAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

interface GithubUser {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string;
}

interface GithubEmail {
  email: string;
  verified: boolean;
}

async function githubApi<T>(fetchFn: FetchLike, token: string, path: string): Promise<T> {
  const response = await fetchFn(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new GithubSignInError(`GitHub API ${path} returned ${response.status}`);
  return (await response.json()) as T;
}

/** Exchange the callback code for a token and read the signed-in identity. */
export async function fetchGithubIdentity(
  fetchFn: FetchLike,
  options: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  },
): Promise<GithubIdentity> {
  const tokenResponse = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: options.code,
      redirect_uri: options.redirectUri,
      code_verifier: options.codeVerifier,
    }).toString(),
  });
  const tokenBody = (await tokenResponse.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
  };
  if (!tokenResponse.ok || !tokenBody.access_token) {
    throw new GithubSignInError(
      `GitHub code exchange failed (${tokenBody.error ?? tokenResponse.status})`,
    );
  }
  const token = tokenBody.access_token;
  const [user, emails] = await Promise.all([
    githubApi<GithubUser>(fetchFn, token, "/user"),
    githubApi<GithubEmail[]>(fetchFn, token, "/user/emails"),
  ]);
  if (!Number.isSafeInteger(user.id) || typeof user.login !== "string") {
    throw new GithubSignInError("GitHub returned an unexpected user profile");
  }
  return {
    githubId: user.id,
    login: user.login,
    name: user.name ?? undefined,
    avatarUrl: user.avatar_url,
    emails: emails.filter((e) => e.verified).map((e) => e.email),
  };
}
