/**
 * Who may sign in: MULTIX_ALLOWED_USERS is a comma-separated list of GitHub
 * logins and/or verified email addresses. An empty list allows nobody.
 * It is checked at sign-in and again on every dashboard and /mcp request, so
 * removing someone takes effect without revoking their tokens first.
 * Local accounts (local-auth.ts) are not on this list; see accountAllowed.
 */

import { type WorkerEnv, csv } from "../config.js";
import { isLocalAccountId, localAccountAllowed } from "./local-auth.js";

export interface AllowlistSubject {
  login: string;
  /** Verified emails only. */
  emails: string[];
}

export function isAllowed(allowlist: string | undefined, subject: AllowlistSubject): boolean {
  const entries = csv(allowlist).map((e) => e.toLowerCase());
  if (entries.length === 0) return false;
  const login = subject.login.toLowerCase();
  const emails = subject.emails.map((e) => e.toLowerCase());
  return entries.some((entry) => (entry.includes("@") ? emails.includes(entry) : entry === login));
}

/**
 * Whether an existing account may use the dashboard, the REST API and /mcp:
 * local accounts (`local-…`) need local sign-in enabled and their credential
 * still in place; GitHub accounts need MULTIX_ALLOWED_USERS.
 */
export async function accountAllowed(
  env: Pick<WorkerEnv, "MULTIX_ALLOWED_USERS" | "MULTIX_LOCAL_AUTH" | "ACCOUNTS_KV">,
  account: AllowlistSubject & { id: string },
): Promise<boolean> {
  if (isLocalAccountId(account.id)) return localAccountAllowed(env, account);
  return isAllowed(env.MULTIX_ALLOWED_USERS, account);
}
