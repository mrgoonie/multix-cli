/**
 * Per-account Cloudflare R2 settings: where the account's job outputs are
 * uploaded. Stored in ACCOUNTS_KV under `r2:<userId>` as one AES-GCM record
 * (same key and scheme as provider keys, bound to the account and to the
 * `r2-settings` name), so the access key pair never sits in KV in plaintext.
 */

import { MAX_URL_CHARS } from "../config.js";
import { logEvent } from "../redaction.js";
import { ACCOUNT_ID_RE, BUCKET_RE } from "../storage/r2-client.js";
import { type EncryptedValue, decryptSecret, encryptSecret } from "./provider-secret-crypto.js";

export interface R2Settings {
  /** Cloudflare account id that owns the bucket (32 lower-case hex characters). */
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** https base URL serving the bucket (custom domain or r2.dev); without it outputs get presigned links. */
  publicBaseUrl?: string;
}

interface StoredR2Settings extends EncryptedValue {
  updatedAt: number;
}

/** Name bound into the ciphertext's additional data. Provider key names are upper-case env names, so it cannot collide. */
const RECORD_NAME = "r2-settings";

const ACCESS_KEY_ID_RE = /^[A-Za-z0-9]{16,128}$/;
/** Printable ASCII without whitespace. */
const SECRET_ACCESS_KEY_RE = /^[\x21-\x7e]{16,1024}$/;

/** Which field was rejected; the dashboard maps it to a fixed message, never echoing the value. */
export type R2SettingsProblem = "account" | "keys" | "bucket" | "url";

export type R2SettingsParse =
  | { ok: true; settings: R2Settings }
  | { ok: false; problem: R2SettingsProblem };

export interface R2SettingsFields {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
}

/** https only, no credentials, query or fragment; returned without a trailing slash. */
function normalisePublicBaseUrl(raw: string): string | undefined {
  if (raw.length > MAX_URL_CHARS) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return undefined;
  }
  if (raw.includes("?") || raw.includes("#")) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Validate dashboard input before any request is made with it (the account id becomes a hostname). */
export function parseR2Settings(fields: R2SettingsFields): R2SettingsParse {
  const accountId = fields.accountId.trim().toLowerCase();
  const accessKeyId = fields.accessKeyId.trim();
  const secretAccessKey = fields.secretAccessKey.trim();
  const bucket = fields.bucket.trim();
  const rawUrl = fields.publicBaseUrl.trim();
  if (!ACCOUNT_ID_RE.test(accountId)) return { ok: false, problem: "account" };
  if (!ACCESS_KEY_ID_RE.test(accessKeyId) || !SECRET_ACCESS_KEY_RE.test(secretAccessKey)) {
    return { ok: false, problem: "keys" };
  }
  if (!BUCKET_RE.test(bucket)) return { ok: false, problem: "bucket" };
  const settings: R2Settings = { accountId, accessKeyId, secretAccessKey, bucket };
  if (rawUrl) {
    const publicBaseUrl = normalisePublicBaseUrl(rawUrl);
    if (!publicBaseUrl) return { ok: false, problem: "url" };
    settings.publicBaseUrl = publicBaseUrl;
  }
  return { ok: true, settings };
}

export function r2SettingsKey(userId: string): string {
  return `r2:${userId}`;
}

export async function writeR2Settings(
  kv: KVNamespace,
  cryptoKey: CryptoKey,
  userId: string,
  settings: R2Settings,
  now = Date.now(),
): Promise<void> {
  const plain: R2Settings = {
    accountId: settings.accountId,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    bucket: settings.bucket,
    ...(settings.publicBaseUrl ? { publicBaseUrl: settings.publicBaseUrl } : {}),
  };
  const encrypted = await encryptSecret(cryptoKey, userId, RECORD_NAME, JSON.stringify(plain));
  const record: StoredR2Settings = { ...encrypted, updatedAt: now };
  await kv.put(r2SettingsKey(userId), JSON.stringify(record));
}

function isR2Settings(value: unknown): value is R2Settings {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accountId === "string" &&
    typeof v.accessKeyId === "string" &&
    typeof v.secretAccessKey === "string" &&
    typeof v.bucket === "string" &&
    (v.publicBaseUrl === undefined || typeof v.publicBaseUrl === "string")
  );
}

/**
 * Decrypted settings, or null when none are saved. A record that no longer
 * decrypts (for example after SECRETS_ENCRYPTION_KEY was replaced) is treated
 * as not configured, like an unreadable provider key.
 */
export async function readR2Settings(
  kv: KVNamespace,
  cryptoKey: CryptoKey,
  userId: string,
): Promise<R2Settings | null> {
  try {
    const record = await kv.get<StoredR2Settings>(r2SettingsKey(userId), { type: "json" });
    if (!record) return null;
    const parsed: unknown = JSON.parse(await decryptSecret(cryptoKey, userId, RECORD_NAME, record));
    if (isR2Settings(parsed)) return parsed;
  } catch {
    // Fall through to the warning below.
  }
  logEvent("warn", "r2_settings_unreadable", { user: userId });
  return null;
}

export async function removeR2Settings(kv: KVNamespace, userId: string): Promise<void> {
  await kv.delete(r2SettingsKey(userId));
}
