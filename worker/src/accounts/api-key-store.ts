/**
 * Account API keys for the REST API (/api/v1). Two kinds of ACCOUNTS_KV entry:
 *
 * - `apikey:<sha256 hex of the key>` -> { userId, id }: the lookup used to
 *   authenticate a request. Only the hash is stored; the key itself is shown
 *   once, when it is created.
 * - `apikeys:<userId>:<id>` -> ApiKeyRecord, also kept as the entry's
 *   metadata: what the dashboard and GET /api/v1/api-keys list (name, a short
 *   prefix, creation time). One entry per key, so two changes at once cannot
 *   drop a key from the list and leave it working but impossible to revoke.
 *
 * Keys are `mxk_` plus 43 base64url characters (32 random bytes), so they
 * cannot be guessed and a hash without a salt is enough. KV is eventually
 * consistent: a revoked key can keep working for up to about a minute in
 * other Cloudflare locations.
 */

const KEY_PREFIX = "mxk_";
const KEY_RE = /^mxk_[A-Za-z0-9_-]{43}$/;
/** Characters of the key kept in the list so a user can tell keys apart. */
const SHOWN_PREFIX_CHARS = 12;

/** Most API keys one account may hold. */
export const MAX_API_KEYS_PER_ACCOUNT = 10;
export const API_KEY_NAME_RE = /^[\x20-\x7e]{1,64}$/;

export interface ApiKeyRecord {
  /** Opaque id used to revoke the key. */
  id: string;
  name: string;
  /** First characters of the key, e.g. `mxk_AbC12345`. */
  prefix: string;
  createdAt: number;
  /** SHA-256 hex of the key: the lookup entry to delete on revoke. */
  hash: string;
}

interface ApiKeyLookup {
  userId: string;
  id: string;
}

export interface ApiKeyOwner {
  userId: string;
  keyId: string;
}

export class TooManyApiKeysError extends Error {
  constructor() {
    super(`An account can hold at most ${MAX_API_KEYS_PER_ACCOUNT} API keys; revoke one first`);
    this.name = "TooManyApiKeysError";
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function lookupKey(hash: string): string {
  return `apikey:${hash}`;
}

function listPrefix(userId: string): string {
  return `apikeys:${userId}:`;
}

function recordKey(userId: string, id: string): string {
  return `${listPrefix(userId)}${id}`;
}

/** Whether a string has the shape of an API key (checked before any KV read). */
export function looksLikeApiKey(value: string): boolean {
  return KEY_RE.test(value);
}

export class ApiKeyStore {
  constructor(private readonly kv: KVNamespace) {}

  async list(userId: string): Promise<ApiKeyRecord[]> {
    const records: ApiKeyRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kv.list<ApiKeyRecord>({ prefix: listPrefix(userId), cursor });
      for (const entry of page.keys) if (entry.metadata) records.push(entry.metadata);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return records.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Create a key; the returned `key` is the only time its value exists outside
   * the caller. Two creates at the same moment can both pass the limit check,
   * which only lets an account briefly hold one or two keys over the limit.
   */
  async create(
    userId: string,
    name: string,
    now = Date.now(),
  ): Promise<{ key: string; record: ApiKeyRecord }> {
    if ((await this.list(userId)).length >= MAX_API_KEYS_PER_ACCOUNT) {
      throw new TooManyApiKeysError();
    }
    const key = `${KEY_PREFIX}${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
    const hash = await sha256Hex(key);
    const record: ApiKeyRecord = {
      id: crypto.randomUUID(),
      name,
      prefix: key.slice(0, SHOWN_PREFIX_CHARS),
      createdAt: now,
      hash,
    };
    // Record first, lookup last: a failure in between leaves a listed key that
    // does not authenticate, never a working key that cannot be revoked.
    const serialized = JSON.stringify(record);
    await this.kv.put(recordKey(userId, record.id), serialized, { metadata: record });
    await this.kv.put(lookupKey(hash), JSON.stringify({ userId, id: record.id } as ApiKeyLookup));
    return { key, record };
  }

  /** Revoke one of the account's keys; false when the account has no key with that id. */
  async revoke(userId: string, id: string): Promise<boolean> {
    const record = await this.kv.get<ApiKeyRecord>(recordKey(userId, id), { type: "json" });
    if (!record) return false;
    // Lookup first: if the second delete fails, the key no longer works and stays listed to retry.
    await this.kv.delete(lookupKey(record.hash));
    await this.kv.delete(recordKey(userId, id));
    return true;
  }

  /** The account a presented key belongs to, or null for a malformed, unknown or revoked key. */
  async verify(presented: string): Promise<ApiKeyOwner | null> {
    if (!looksLikeApiKey(presented)) return null;
    const lookup = await this.kv.get<ApiKeyLookup>(lookupKey(await sha256Hex(presented)), {
      type: "json",
    });
    return lookup ? { userId: lookup.userId, keyId: lookup.id } : null;
  }
}

/** What the dashboard and the API may show about a key (never the hash). */
export function publicApiKey(record: ApiKeyRecord): {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
} {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    created_at: new Date(record.createdAt).toISOString(),
  };
}
