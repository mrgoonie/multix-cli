/**
 * Who may sign in: MULTIX_ALLOWED_USERS is a comma-separated list of GitHub
 * logins and/or verified email addresses. An empty list allows nobody.
 * It is checked at sign-in and again on every dashboard and /mcp request, so
 * removing someone takes effect without revoking their tokens first.
 */

import { csv } from "../config.js";

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
