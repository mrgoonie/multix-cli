/**
 * Per-request context for the sign-in, consent and dashboard routes.
 * Resolving it fails closed: a missing or weak Worker secret means the routes
 * answer 503 instead of running half-configured.
 */

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { FetchLike } from "../../src/core/fetch-json.js";
import { AccountStore } from "./accounts/account-store.js";
import type { Account } from "./accounts/account-store.js";
import { isAllowed } from "./accounts/allowlist.js";
import { importEncryptionKey } from "./accounts/provider-secret-crypto.js";
import { type Session, readSession } from "./auth/signed-cookies.js";
import { MIN_SESSION_SECRET_LENGTH, type WorkerEnv } from "./config.js";
import type { JobBackend } from "./jobs/job-store.js";

export interface AppDeps {
  /** Injected for tests; defaults to the Worker's fetch (GitHub sign-in and R2 checks). */
  fetch?: FetchLike;
  /** Injected for tests; defaults to the MULTIX_JOBS Durable Object namespace. */
  jobBackend?: JobBackend;
}

export interface AppContext {
  env: WorkerEnv;
  /** Public origin without a trailing slash, e.g. https://multix.zuey.me. */
  origin: string;
  sessionSecret: string;
  githubClientId: string;
  githubClientSecret: string;
  accounts: AccountStore;
  fetch: FetchLike;
}

/** Normalised public origin, or undefined when MULTIX_PUBLIC_URL is missing or not https. */
export function publicOrigin(env: WorkerEnv): string | undefined {
  const raw = env.MULTIX_PUBLIC_URL?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export async function resolveAppContext(
  env: WorkerEnv,
  deps: AppDeps,
): Promise<AppContext | undefined> {
  const origin = publicOrigin(env);
  const sessionSecret = env.SESSION_SECRET?.trim() ?? "";
  const githubClientId = env.GITHUB_CLIENT_ID?.trim() ?? "";
  const githubClientSecret = env.GITHUB_CLIENT_SECRET?.trim() ?? "";
  if (
    !origin ||
    sessionSecret.length < MIN_SESSION_SECRET_LENGTH ||
    !githubClientId ||
    !githubClientSecret ||
    !env.ACCOUNTS_KV
  ) {
    return undefined;
  }
  let encryptionKey: Promise<CryptoKey>;
  try {
    encryptionKey = importEncryptionKey(env.SECRETS_ENCRYPTION_KEY);
    await encryptionKey;
  } catch {
    return undefined;
  }
  return {
    env,
    origin,
    sessionSecret,
    githubClientId,
    githubClientSecret,
    accounts: new AccountStore(env.ACCOUNTS_KV, encryptionKey),
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
  };
}

export interface SignedIn {
  account: Account;
  session: Session;
}

/**
 * The signed-in account and its session, if the session is valid, was issued
 * after the account's last sign-out, and the account is still allowlisted.
 */
export async function signedInSession(
  ctx: AppContext,
  request: Request,
): Promise<SignedIn | undefined> {
  const session = await readSession(request, ctx.sessionSecret);
  // Cookies from before sessions carried an issue time are void, never "issued at 0".
  if (!session || typeof session.iat !== "number") return undefined;
  const [account, signedOutAt] = await Promise.all([
    ctx.accounts.get(session.userId),
    ctx.accounts.signedOutAt(session.userId),
  ]);
  if (!account || !isAllowed(ctx.env.MULTIX_ALLOWED_USERS, account)) return undefined;
  // KV may take ~60 s to show a sign-out made in another location.
  if (session.iat <= signedOutAt) return undefined;
  return { account, session };
}

export async function signedInAccount(
  ctx: AppContext,
  request: Request,
): Promise<Account | undefined> {
  return (await signedInSession(ctx, request))?.account;
}

export function oauthHelpers(env: WorkerEnv): OAuthHelpers {
  if (!env.OAUTH_PROVIDER) throw new Error("OAUTH_PROVIDER helpers are not available");
  return env.OAUTH_PROVIDER;
}

/** Form POSTs must come from our own pages (on top of SameSite=Lax cookies and CSRF tokens). */
export function sameOriginPost(ctx: AppContext, request: Request): boolean {
  return request.headers.get("origin") === ctx.origin;
}
