/**
 * Accounts in ACCOUNTS_KV, two JSON documents per account:
 *
 * - `account:<userId>`: the GitHub identity used for the allowlist, rewritten
 *   at every sign-in.
 * - `secrets:<userId>`: the provider keys, each AES-GCM encrypted
 *   (provider-secret-crypto.ts), written only by the dashboard. Keeping them
 *   apart means a sign-in that reads a stale copy cannot drop a saved key.
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
import { logEvent } from "../redaction.js";
import { type EncryptedValue, decryptSecret, encryptSecret } from "./provider-secret-crypto.js";

export interface StoredSecret extends EncryptedValue {
  updatedAt: number;
}

export type SecretRecords = Partial<Record<ProviderSecretName, StoredSecret>>;

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
  /**
   * Dashboard sessions carry this number; signing out increments it, which
   * ends every session of the account on every device (missing means 0).
   */
  sessionVersion?: number;
}

export interface GithubIdentity {
  githubId: number;
  login: string;
  name?: string;
  avatarUrl?: string;
  emails: string[];
}

/** Longest provider value accepted from the dashboard. */
export const MAX_SECRET_CHARS = 1024;

export function accountIdFor(githubId: number): string {
  return `gh-${githubId}`;
}

function key(userId: string): string {
  return `account:${userId}`;
}

function secretsKey(userId: string): string {
  return `secrets:${userId}`;
}

export function sessionVersionOf(account: Account): number {
  return account.sessionVersion ?? 0;
}

export function isProviderSecretName(name: string): name is ProviderSecretName {
  return (PROVIDER_SECRET_NAMES as readonly string[]).includes(name);
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
      sessionVersion: existing?.sessionVersion ?? 0,
    };
    await this.put(account);
    return account;
  }

  /** End every dashboard session of the account (sign out everywhere). */
  async endSessions(userId: string): Promise<void> {
    const account = await this.get(userId);
    if (!account) return;
    account.sessionVersion = sessionVersionOf(account) + 1;
    await this.put(account);
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
}

/** Tool env for one account: operator limits plus only that account's keys. */
export function toolEnvFor(settings: ServerSettings, keys: ProviderKeys): Env {
  return { ...settings, ...keys };
}
