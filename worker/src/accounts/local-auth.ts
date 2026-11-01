/**
 * Local sign-in (username and password) with a single-use bootstrap admin, so
 * a self-hosted server needs no GitHub OAuth App. Enabled only when
 * MULTIX_LOCAL_AUTH is "true". Web Crypto only: this module runs in the
 * Worker and in the Node server (`worker/server/`), and must not import
 * `node:*` modules.
 *
 * ACCOUNTS_KV entries:
 *
 * - `local-user:<lower-case username>`: `{ accountId, salt, hash, iterations,
 *   createdAt }`, a PBKDF2-SHA256 hash of the password (salt and hash in
 *   base64url). The account itself is a normal `account:<id>` record with id
 *   `local-<random>`, so provider keys, R2, API keys and sign-out work as for
 *   GitHub accounts. Deleting this entry locks the account out.
 * - `local-setup`: `{ doneAt, accountId }`, written once the bootstrap admin
 *   exists; from then on /dashboard/setup answers 404.
 * - `local-setup-token`: `{ hash }`, base64url SHA-256 of a bootstrap token
 *   the Node server generates at boot (storeBootstrapTokenHash). Deleted when
 *   setup completes. MULTIX_BOOTSTRAP_TOKEN is accepted as well.
 *
 * KV has no transactions: setup re-reads `local-setup` right before it writes,
 * which closes the race on the Node server (one replica, strongly consistent
 * SQLite KV). On Cloudflare KV, two setups at the same moment from different
 * locations could both pass; both need the bootstrap token, so the operator
 * controls who can try.
 */

import type { WorkerEnv } from "../config.js";
import { tokensMatch } from "../http-guards.js";
import { base64UrlToBytes, bytesToBase64Url, randomBase64Url } from "./base64.js";

/** Account ids of local users start with this; GitHub accounts use `gh-`. */
export const LOCAL_ACCOUNT_PREFIX = "local-";
/** Lower-case username: 3–32 characters, starting with a letter or digit. */
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const MIN_PASSWORD_CHARS = 12;
export const MAX_PASSWORD_CHARS = 256;
/** Shortest accepted MULTIX_BOOTSTRAP_TOKEN; shorter values are ignored (fail closed). */
export const MIN_BOOTSTRAP_TOKEN_LENGTH = 32;
/** The Workers runtime refuses PBKDF2 above 100 000 iterations. */
export const PBKDF2_ITERATIONS = 100_000;

const HASH_BITS = 256;
const SALT_BYTES = 16;
const SETUP_KEY = "local-setup";
const SETUP_TOKEN_KEY = "local-setup-token";
const encoder = new TextEncoder();

export interface LocalCredential {
  accountId: string;
  /** base64url */
  salt: string;
  /** base64url PBKDF2-SHA256 output */
  hash: string;
  iterations: number;
  createdAt: number;
}

export interface SetupRecord {
  doneAt: number;
  accountId: string;
}

export function localAuthEnabled(env: Pick<WorkerEnv, "MULTIX_LOCAL_AUTH">): boolean {
  return env.MULTIX_LOCAL_AUTH?.trim().toLowerCase() === "true";
}

export function isLocalAccountId(id: string): boolean {
  return id.startsWith(LOCAL_ACCOUNT_PREFIX);
}

export function newLocalAccountId(): string {
  return `${LOCAL_ACCOUNT_PREFIX}${randomBase64Url(16)}`;
}

/** Trimmed, lower-case username if it is valid, else undefined. */
export function normalizeUsername(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const username = raw.trim().toLowerCase();
  return USERNAME_RE.test(username) ? username : undefined;
}

export function isAcceptablePassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_CHARS && password.length <= MAX_PASSWORD_CHARS;
}

function credentialKey(username: string): string {
  return `local-user:${username}`;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password.normalize("NFC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    HASH_BITS,
  );
  return bytesToBase64Url(new Uint8Array(bits));
}

export async function hashPassword(
  password: string,
  accountId: string,
  now = Date.now(),
): Promise<LocalCredential> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return {
    accountId,
    salt: bytesToBase64Url(salt),
    hash: await pbkdf2(password, salt, PBKDF2_ITERATIONS),
    iterations: PBKDF2_ITERATIONS,
    createdAt: now,
  };
}

/**
 * Whether `password` matches the credential. With no credential (unknown
 * user) a dummy derivation still runs, so the response time does not reveal
 * whether the username exists.
 */
export async function verifyPassword(
  credential: LocalCredential | null,
  password: string,
): Promise<boolean> {
  if (!credential || password === "") {
    const dummySalt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    await pbkdf2(password || "\u0000", dummySalt, PBKDF2_ITERATIONS);
    return false;
  }
  const { iterations } = credential;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) {
    return false;
  }
  let salt: Uint8Array;
  try {
    salt = base64UrlToBytes(credential.salt);
  } catch {
    return false;
  }
  const derived = await pbkdf2(password, salt, iterations);
  return tokensMatch(derived, credential.hash);
}

export function readLocalCredential(
  kv: KVNamespace,
  username: string,
): Promise<LocalCredential | null> {
  return kv.get<LocalCredential>(credentialKey(username), { type: "json" });
}

export async function writeLocalCredential(
  kv: KVNamespace,
  username: string,
  credential: LocalCredential,
): Promise<void> {
  await kv.put(credentialKey(username), JSON.stringify(credential));
}

/** Whether the bootstrap admin was created (setup is closed for good). */
export async function isBootstrapDone(kv: KVNamespace): Promise<boolean> {
  return (await kv.get(SETUP_KEY, "text")) !== null;
}

export async function markBootstrapDone(
  kv: KVNamespace,
  accountId: string,
  now = Date.now(),
): Promise<void> {
  const record: SetupRecord = { doneAt: now, accountId };
  await kv.put(SETUP_KEY, JSON.stringify(record));
  await kv.delete(SETUP_TOKEN_KEY);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

/**
 * Store the hash of a bootstrap token generated by the server at boot (the
 * token itself is printed once to the operator, never stored). Throws on a
 * token shorter than MIN_BOOTSTRAP_TOKEN_LENGTH.
 */
export async function storeBootstrapTokenHash(kv: KVNamespace, token: string): Promise<void> {
  if (token.length < MIN_BOOTSTRAP_TOKEN_LENGTH) {
    throw new Error(`Bootstrap token must be at least ${MIN_BOOTSTRAP_TOKEN_LENGTH} characters`);
  }
  await kv.put(SETUP_TOKEN_KEY, JSON.stringify({ hash: await sha256Base64Url(token) }));
}

/** Forget a generated bootstrap token (when the operator supplies MULTIX_BOOTSTRAP_TOKEN instead). */
export async function clearStoredBootstrapToken(kv: KVNamespace): Promise<void> {
  await kv.delete(SETUP_TOKEN_KEY);
}

/**
 * Whether `given` is MULTIX_BOOTSTRAP_TOKEN (when that is at least
 * MIN_BOOTSTRAP_TOKEN_LENGTH long) or the token whose hash the server stored.
 * Both comparisons are constant-time.
 */
export async function bootstrapTokenValid(
  env: Pick<WorkerEnv, "MULTIX_BOOTSTRAP_TOKEN">,
  kv: KVNamespace,
  given: string,
): Promise<boolean> {
  if (!given) return false;
  const configured = env.MULTIX_BOOTSTRAP_TOKEN?.trim() ?? "";
  if (configured.length >= MIN_BOOTSTRAP_TOKEN_LENGTH && (await tokensMatch(given, configured))) {
    return true;
  }
  const stored = await kv.get<{ hash?: unknown }>(SETUP_TOKEN_KEY, { type: "json" });
  if (typeof stored?.hash !== "string" || !stored.hash) return false;
  return tokensMatch(await sha256Base64Url(given), stored.hash);
}

/**
 * A local account may be used while local sign-in is enabled and its
 * credential still exists and points at it (read uncached on every check).
 */
export async function localAccountAllowed(
  env: Pick<WorkerEnv, "MULTIX_LOCAL_AUTH" | "ACCOUNTS_KV">,
  account: { id: string; login: string },
): Promise<boolean> {
  if (!localAuthEnabled(env)) return false;
  const username = normalizeUsername(account.login);
  if (!username) return false;
  const credential = await readLocalCredential(env.ACCOUNTS_KV, username);
  return credential?.accountId === account.id;
}
