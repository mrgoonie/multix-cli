/**
 * POST /dashboard/storage: save (after a live access check) or remove the
 * account's R2 settings. Called by dashboard-routes.ts after the Origin,
 * session and CSRF checks. Outcomes are reported with fixed notice codes
 * (pages/notice-codes.ts); submitted values are never echoed or logged.
 */

import type { Account } from "../accounts/account-store.js";
import { parseR2Settings, r2Prefix } from "../accounts/r2-settings.js";
import type { AppContext } from "../app-context.js";
import { redirect } from "../http-responses.js";
import { logEvent } from "../redaction.js";
import { checkR2Access } from "../storage/r2-access-check.js";

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
    prefix: field(form, "prefix"),
  });
  if (!parsed.ok) return redirect(`/dashboard?notice=r2-invalid-${parsed.problem}`);

  const result = await checkR2Access(parsed.settings, ctx.fetch, r2Prefix(parsed.settings));
  if (result !== "ok") {
    logEvent("warn", "r2_settings_check_failed", { user: account.id, result });
    return redirect(`/dashboard?notice=r2-${result}`);
  }
  await ctx.accounts.saveR2Settings(account.id, parsed.settings);
  logEvent("info", "r2_settings_saved", { user: account.id });
  return redirect("/dashboard?notice=r2-saved");
}
