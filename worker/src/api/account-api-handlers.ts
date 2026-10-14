/**
 * REST handlers for the account itself: who is calling, provider keys, R2
 * storage and API keys. Key values and R2 credentials are write-only: no
 * response ever contains them, and errors name the field, not the value.
 */

import type { Account, SecretChanges } from "../accounts/account-store.js";
import { isProviderSecretName, isValidSecretValue } from "../accounts/account-store.js";
import { ApiKeyStore, publicApiKey } from "../accounts/api-key-store.js";
import { type R2SettingsProblem, parseR2Settings, r2Prefix } from "../accounts/r2-settings.js";
import type { AppContext } from "../app-context.js";
import { json } from "../http-responses.js";
import { PROVIDER_SECRET_NAMES } from "../provider-secret-names.js";
import { logEvent } from "../redaction.js";
import { checkR2Access } from "../storage/r2-access-check.js";
import { ApiError, readJsonObject } from "./api-http.js";

export interface ApiCaller {
  account: Account;
  /** Id of the API key that authenticated the request. */
  keyId: string;
}

export function getMe(caller: ApiCaller): Response {
  const { account } = caller;
  return json(200, {
    id: account.id,
    login: account.login,
    name: account.name ?? null,
    api_key_id: caller.keyId,
  });
}

/** Every provider key name with whether it is set and when; never values. */
export async function listProviderKeys(app: AppContext, caller: ApiCaller): Promise<Response> {
  const secrets = await app.accounts.secrets(caller.account.id);
  return json(200, {
    keys: PROVIDER_SECRET_NAMES.map((name) => {
      const stored = secrets[name];
      return {
        name,
        set: Boolean(stored),
        updated_at: stored ? new Date(stored.updatedAt).toISOString() : null,
      };
    }),
  });
}

function secretValue(name: string, raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || !isValidSecretValue(value)) {
    throw new ApiError(
      400,
      "bad_request",
      `${name}: the value must be a string of 1-1024 printable characters without spaces`,
    );
  }
  return value;
}

function secretName(name: string): asserts name is keyof SecretChanges {
  if (!isProviderSecretName(name)) {
    // Echo only env-style names, so a value pasted in the wrong place is never returned.
    const shown = /^[A-Z][A-Z0-9_]{0,63}$/.test(name) ? `: ${name}` : "";
    throw new ApiError(400, "bad_request", `Unknown provider key name${shown}`);
  }
}

/** PATCH /provider-keys: `{ "keys": { NAME: "value" | null } }`; validated in full before any write. */
export async function patchProviderKeys(
  app: AppContext,
  caller: ApiCaller,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const keys = body.keys;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    throw new ApiError(
      400,
      "bad_request",
      'The body must be { "keys": { "NAME": "value" | null } }',
    );
  }
  const changes: SecretChanges = {};
  for (const [name, raw] of Object.entries(keys as Record<string, unknown>)) {
    secretName(name);
    changes[name] = raw === null ? null : secretValue(name, raw);
  }
  const names = Object.keys(changes);
  if (names.length === 0) throw new ApiError(400, "bad_request", "keys is empty");
  await app.accounts.updateSecrets(caller.account.id, changes);
  const saved = names.filter((n) => changes[n as keyof SecretChanges] !== null);
  const removed = names.filter((n) => changes[n as keyof SecretChanges] === null);
  logEvent("info", "provider_keys_updated_api", {
    user: caller.account.id,
    saved: saved.join(","),
    removed: removed.join(","),
  });
  return json(200, { saved, removed });
}

/** PUT /provider-keys/{name}: `{ "value": "..." }`. */
export async function putProviderKey(
  app: AppContext,
  caller: ApiCaller,
  name: string,
  request: Request,
): Promise<Response> {
  secretName(name);
  const value = secretValue(name, (await readJsonObject(request)).value);
  await app.accounts.setSecret(caller.account.id, name, value);
  logEvent("info", "provider_key_saved_api", { user: caller.account.id, name });
  return json(200, { saved: [name], removed: [] });
}

export async function deleteProviderKey(
  app: AppContext,
  caller: ApiCaller,
  name: string,
): Promise<Response> {
  secretName(name);
  await app.accounts.deleteSecret(caller.account.id, name);
  logEvent("info", "provider_key_removed_api", { user: caller.account.id, name });
  return json(200, { saved: [], removed: [name] });
}

export async function getStorage(app: AppContext, caller: ApiCaller): Promise<Response> {
  const r2 = await app.accounts.r2Settings(caller.account.id);
  return json(
    200,
    r2
      ? {
          configured: true,
          account_id: r2.accountId,
          bucket: r2.bucket,
          public_base_url: r2.publicBaseUrl ?? null,
          prefix: r2Prefix(r2),
        }
      : { configured: false },
  );
}

const STORAGE_PROBLEMS: Record<R2SettingsProblem, string> = {
  account: "account_id must be 32 hexadecimal characters",
  keys: "access_key_id must be 16-128 letters or digits and secret_access_key 16-1024 characters without spaces",
  bucket: "bucket must be 3-63 lower-case letters, digits or hyphens",
  url: "public_base_url must be an https URL without a query string or fragment",
  prefix:
    "prefix may only use letters, digits, '.', '_', '-' and '/' (no '.' or '..' segments, at most 256 characters)",
};

function field(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === "string" ? value : "";
}

/** PUT /storage: validate, check access with a list, upload and delete, then save. */
export async function putStorage(
  app: AppContext,
  caller: ApiCaller,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const parsed = parseR2Settings({
    accountId: field(body, "account_id"),
    accessKeyId: field(body, "access_key_id"),
    secretAccessKey: field(body, "secret_access_key"),
    bucket: field(body, "bucket"),
    publicBaseUrl: field(body, "public_base_url"),
    prefix: field(body, "prefix"),
  });
  if (!parsed.ok) throw new ApiError(400, "bad_request", STORAGE_PROBLEMS[parsed.problem]);
  const result = await checkR2Access(parsed.settings, app.fetch, r2Prefix(parsed.settings));
  if (result !== "ok") {
    logEvent("warn", "r2_settings_check_failed", { user: caller.account.id, result });
    throw new ApiError(
      422,
      "storage_check_failed",
      `R2 access check failed (${result}); nothing was saved. Use a token with Object Read & Write on this bucket.`,
    );
  }
  await app.accounts.saveR2Settings(caller.account.id, parsed.settings);
  logEvent("info", "r2_settings_saved_api", { user: caller.account.id });
  return getStorage(app, caller);
}

export async function deleteStorage(app: AppContext, caller: ApiCaller): Promise<Response> {
  await app.accounts.deleteR2Settings(caller.account.id);
  logEvent("info", "r2_settings_removed_api", { user: caller.account.id });
  return json(200, { configured: false });
}

export async function listApiKeys(app: AppContext, caller: ApiCaller): Promise<Response> {
  const keys = await new ApiKeyStore(app.env.ACCOUNTS_KV).list(caller.account.id);
  return json(200, { api_keys: keys.map(publicApiKey) });
}

/** DELETE /api-keys/{id}. A key may revoke itself; creating keys is dashboard-only. */
export async function revokeApiKey(
  app: AppContext,
  caller: ApiCaller,
  id: string,
): Promise<Response> {
  const revoked = await new ApiKeyStore(app.env.ACCOUNTS_KV).revoke(caller.account.id, id);
  if (!revoked) throw new ApiError(404, "not_found", "API key not found");
  logEvent("info", "api_key_revoked_api", { user: caller.account.id });
  return json(200, { revoked: id });
}
