/**
 * POST /dashboard/storage: save (after a live access check) or remove the
 * account's R2 settings. Called by dashboard-routes.ts after the Origin,
 * session and CSRF checks. Outcomes are reported with fixed notice codes;
 * submitted values are never echoed or logged.
 */

import type { Account } from "../accounts/account-store.js";
import { type R2SettingsProblem, parseR2Settings } from "../accounts/r2-settings.js";
import type { AppContext } from "../app-context.js";
import { redirect } from "../http-responses.js";
import { logEvent } from "../redaction.js";
import { type R2AccessResult, checkR2Access } from "../storage/r2-access-check.js";

export interface Notice {
  text: string;
  warn?: boolean;
}

const PROBLEM_NOTICES: Record<R2SettingsProblem, Notice> = {
  account: {
    text: "R2 settings not saved: the account ID must be 32 hexadecimal characters.",
    warn: true,
  },
  keys: {
    text: "R2 settings not saved: the access key ID must be 16–128 letters or digits and the secret 16–1024 characters without spaces.",
    warn: true,
  },
  bucket: {
    text: "R2 settings not saved: the bucket name must be 3–63 lower-case letters, digits or hyphens.",
    warn: true,
  },
  url: {
    text: "R2 settings not saved: the public base URL must be an https URL without a query string or fragment.",
    warn: true,
  },
};

const CHECK_NOTICES: Record<Exclude<R2AccessResult, "ok">, Notice> = {
  denied: {
    text: "R2 settings not saved: R2 refused the credentials. Check the key pair and that the token covers this bucket.",
    warn: true,
  },
  "no-bucket": {
    text: "R2 settings not saved: the bucket does not exist in that account.",
    warn: true,
  },
  "read-only": {
    text: "R2 settings not saved: the token can read the bucket but not write to it. Use Object Read & Write.",
    warn: true,
  },
  "no-delete": {
    text: "R2 settings not saved: the token could upload but not delete the probe object. Use Object Read & Write.",
    warn: true,
  },
  unreachable: { text: "R2 settings not saved: R2 could not be reached. Try again.", warn: true },
  error: { text: "R2 settings not saved: R2 returned an unexpected error. Try again.", warn: true },
};

/** Notice codes of this route (`/dashboard?notice=<code>`). */
export const R2_NOTICES: Record<string, Notice> = {
  "r2-saved": { text: "R2 storage saved. Access was checked with a list, upload and delete." },
  "r2-removed": { text: "R2 storage removed." },
  ...Object.fromEntries(Object.entries(PROBLEM_NOTICES).map(([k, v]) => [`r2-invalid-${k}`, v])),
  ...Object.fromEntries(Object.entries(CHECK_NOTICES).map(([k, v]) => [`r2-${k}`, v])),
};

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function handleR2SettingsPost(
  ctx: AppContext,
  account: Account,
  form: FormData,
): Promise<Response> {
  if (form.get("intent") === "delete") {
    await ctx.accounts.deleteR2Settings(account.id);
    logEvent("info", "r2_settings_removed", { user: account.id });
    return redirect("/dashboard?notice=r2-removed");
  }
  const parsed = parseR2Settings({
    accountId: field(form, "account_id"),
    accessKeyId: field(form, "access_key_id"),
    secretAccessKey: field(form, "secret_access_key"),
    bucket: field(form, "bucket"),
    publicBaseUrl: field(form, "public_base_url"),
  });
  if (!parsed.ok) return redirect(`/dashboard?notice=r2-invalid-${parsed.problem}`);

  const result = await checkR2Access(parsed.settings, ctx.fetch);
  if (result !== "ok") {
    logEvent("warn", "r2_settings_check_failed", { user: account.id, result });
    return redirect(`/dashboard?notice=r2-${result}`);
  }
  await ctx.accounts.saveR2Settings(account.id, parsed.settings);
  logEvent("info", "r2_settings_saved", { user: account.id });
  return redirect("/dashboard?notice=r2-saved");
}
