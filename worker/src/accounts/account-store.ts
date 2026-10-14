/**
 * Accounts in ACCOUNTS_KV, up to four entries per account:
 *
 * - `account:<userId>`: the GitHub identity used for the allowlist, rewritten
 *   at every sign-in.
 * - `secrets:<userId>`: the provider keys, each AES-GCM encrypted
 *   (provider-secret-crypto.ts), written only by the dashboard. Keeping them
 *   apart means a sign-in that reads a stale copy cannot drop a saved key.
 * - `signed-out:<userId>`: time of the last "sign out", written only by
 *   endSessions, so a stale read elsewhere can delay a sign-out but never undo it.
 * - `r2:<userId>`: the account's own R2 bucket settings, one AES-GCM record
 *   (r2-settings.ts), written only by the dashboard.
 *
 * Plaintext keys exist only in memory while a request uses them; nothing here
 * returns them to the dashboard.
 *
 * KV is eventually consistent: a key saved in one Cloudflare location can take
 * up to about a minute to be visible to /mcp requests served elsewhere.
 */

import {
  type Env,
  PROVIDER_SECRET_NAMES,
  type ProviderKeys,
  type ProviderSecretName,
  type ServerSettings,
} from "../config.js";
import { isProviderSecretName } from "../provider-secret-names.js";
import { logEvent } from "../redaction.js";
import { type EncryptedValue, decryptSecret, encryptSecret } from "./provider-secret-crypto.js";
import {
  type R2Settings,
  readR2Settings,
  removeR2Settings,
  writeR2Settings,
} from "./r2-settings.js";

export { isProviderSecretName };

export interface StoredSecret extends EncryptedValue {
  updatedAt: number;
}

export type SecretRecords = Partial<Record<ProviderSecretName, StoredSecret>>;

export type { R2Settings };

export interface Account {
  /** `gh-<numeric GitHub id>`: stable across login renames; no `:` (OAuth token format). */
  id: string;
  githubId: number;
  login: string;
  name?: string;
  avatarUrl?: string;
  /** Verified emails reported by GitHub at the last sign-in (lower-case). */
  emails: string[];
  createdAt: number;
  lastLoginAt: number;
}

export interface GithubIdentity {
  githubId: number;
  login: string;
  name?: string;
  avatarUrl?: string;
  emails: string[];
}

/** Longest provider value accepted from the dashboard and the API. */
export const MAX_SECRET_CHARS = 1024;

/** Printable ASCII, no whitespace: every supported provider key and id fits. */
const SECRET_VALUE_RE = /^[\x21-\x7e]+$/;

/** Whether a (trimmed) provider value may be saved. */
export function isValidSecretValue(value: string): boolean {
  return value.length <= MAX_SECRET_CHARS && SECRET_VALUE_RE.test(value);
}

/** Changes for updateSecrets: a value to save, or null to remove the key. */
export type SecretChanges = Partial<Record<ProviderSecretName, string | null>>;

export function accountIdFor(githubId: number): string {
  return `gh-${githubId}`;
}

function key(userId: string): string {
  return `account:${userId}`;
}

function secretsKey(userId: string): string {
  return `secrets:${userId}`;
}

function signedOutKey(userId: string): string {
  return `signed-out:${userId}`;
}

export class AccountStore {
  constructor(
    private readonly kv: KVNamespace,
    private readonly encryptionKey: Promise<CryptoKey>,
  ) {}

  async get(userId: string): Promise<Account | null> {
    return this.kv.get<Account>(key(userId), { type: "json" });
  }

  private async put(account: Account): Promise<void> {
    await this.kv.put(key(account.id), JSON.stringify(account));
  }

  /** Create the account on first sign-in, or refresh its GitHub identity. */
  async upsertFromGithub(identity: GithubIdentity, now = Date.now()): Promise<Account> {
    const id = accountIdFor(identity.githubId);
    const existing = await this.get(id);
    const account: Account = {
      id,
      githubId: identity.githubId,
      login: identity.login,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
      emails: identity.emails.map((e) => e.toLowerCase()),
      createdAt: existing?.createdAt ?? now,
      lastLoginAt: now,
    };
    await this.put(account);
    return account;
  }

  /** End every dashboard session of the account issued before `now`. */
  async endSessions(userId: string, now = Date.now()): Promise<void> {
    await this.kv.put(signedOutKey(userId), String(now));
  }

  /** Time (ms) of the account's last sign-out; 0 if it never signed out. */
  async signedOutAt(userId: string): Promise<number> {
    const value = Number(await this.kv.get(signedOutKey(userId), "text"));
    return Number.isFinite(value) ? value : 0;
  }

  /** Encrypted provider keys of the account (shown on the dashboard only as "saved"). */
  async secrets(userId: string): Promise<SecretRecords> {
    return (await this.kv.get<SecretRecords>(secretsKey(userId), { type: "json" })) ?? {};
  }

  async setSecret(
    userId: string,
    name: ProviderSecretName,
    value: string,
    now = Date.now(),
  ): Promise<void> {
    const secrets = await this.secrets(userId);
    const encrypted = await encryptSecret(await this.encryptionKey, userId, name, value);
    secrets[name] = { ...encrypted, updatedAt: now };
    await this.kv.put(secretsKey(userId), JSON.stringify(secrets));
  }

  /** Save and remove several keys with one read and one write of the account's record. */
  async updateSecrets(userId: string, changes: SecretChanges, now = Date.now()): Promise<void> {
    const secrets = await this.secrets(userId);
    const cryptoKey = await this.encryptionKey;
    for (const [name, value] of Object.entries(changes) as [ProviderSecretName, string | null][]) {
      if (value === null) {
        delete secrets[name];
      } else {
        const encrypted = await encryptSecret(cryptoKey, userId, name, value);
        secrets[name] = { ...encrypted, updatedAt: now };
      }
    }
    await this.kv.put(secretsKey(userId), JSON.stringify(secrets));
  }

  async deleteSecret(userId: string, name: ProviderSecretName): Promise<void> {
    const secrets = await this.secrets(userId);
    if (!secrets[name]) return;
    delete secrets[name];
    await this.kv.put(secretsKey(userId), JSON.stringify(secrets));
  }

  /**
   * Decrypt the account's provider keys for one request. A key that no longer
   * decrypts (for example after SECRETS_ENCRYPTION_KEY was replaced) is
   * treated as not set, so the other providers keep working.
   */
  async providerKeys(userId: string): Promise<ProviderKeys> {
    const cryptoKey = await this.encryptionKey;
    const secrets = await this.secrets(userId);
    const keys: ProviderKeys = {};
    for (const name of PROVIDER_SECRET_NAMES) {
      const record = secrets[name];
      if (!record) continue;
      try {
        keys[name] = await decryptSecret(cryptoKey, userId, name, record);
      } catch {
        logEvent("warn", "provider_secret_unreadable", { user: userId, secret: name });
      }
    }
    return keys;
  }

  /** The account's decrypted R2 settings for one request, or null when none are saved. */
  async r2Settings(userId: string): Promise<R2Settings | null> {
    return readR2Settings(this.kv, await this.encryptionKey, userId);
  }

  async saveR2Settings(userId: string, settings: R2Settings, now = Date.now()): Promise<void> {
    await writeR2Settings(this.kv, await this.encryptionKey, userId, settings, now);
  }

  async deleteR2Settings(userId: string): Promise<void> {
    await removeR2Settings(this.kv, userId);
  }
}

/** Tool env for one account: operator limits plus only that account's keys. */
export function toolEnvFor(settings: ServerSettings, keys: ProviderKeys): Env {
  return { ...settings, ...keys };
}
