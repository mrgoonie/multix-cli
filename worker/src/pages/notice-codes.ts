/**
 * Codes of the one-line notices the dashboard shows after a form POST
 * (`/dashboard?notice=<code>`). Routes redirect with a code; the page looks up
 * its text in the visitor's language (i18n-*.ts). Unknown codes show nothing.
 */

import type { R2SettingsProblem } from "../accounts/r2-settings.js";
import type { R2AccessResult } from "../storage/r2-access-check.js";

const R2_PROBLEMS = ["account", "keys", "bucket", "url", "prefix"] as const;
const R2_CHECKS = [
  "denied",
  "no-bucket",
  "read-only",
  "no-delete",
  "unreachable",
  "error",
] as const;

// Compile-time checks that the lists above cover the routes' result types.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const r2ProblemsCovered: Same<(typeof R2_PROBLEMS)[number], R2SettingsProblem> = true;
const r2ChecksCovered: Same<(typeof R2_CHECKS)[number], Exclude<R2AccessResult, "ok">> = true;
void r2ProblemsCovered;
void r2ChecksCovered;

const WARNINGS = [
  "invalid",
  "api-key-not-found",
  "api-key-invalid-name",
  "api-key-limit",
  ...R2_PROBLEMS.map((p) => `r2-invalid-${p}` as const),
  ...R2_CHECKS.map((c) => `r2-${c}` as const),
] as const;

const NOTICE_CODES = [
  "saved",
  "removed",
  "disconnected",
  "api-key-revoked",
  "r2-saved",
  "r2-removed",
  ...WARNINGS,
] as const;

export type NoticeCode = (typeof NOTICE_CODES)[number];

const CODES: ReadonlySet<string> = new Set(NOTICE_CODES);
const WARNING_CODES: ReadonlySet<string> = new Set(WARNINGS);

export function isNoticeCode(value: string): value is NoticeCode {
  return CODES.has(value);
}

/** Notices that report something not done; shown with the warning style. */
export function isWarning(code: NoticeCode): boolean {
  return WARNING_CODES.has(code);
}
