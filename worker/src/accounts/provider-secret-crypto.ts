/**
 * AES-256-GCM encryption for provider keys stored in ACCOUNTS_KV.
 *
 * The key comes from the SECRETS_ENCRYPTION_KEY Worker secret (base64 of 32
 * random bytes). Each value gets a fresh 96-bit IV, and the additional
 * authenticated data binds the ciphertext to its account and secret name, so a
 * record copied to another account or field fails to decrypt.
 */

import { base64ToBytes, bytesToBase64 } from "./base64.js";

export interface EncryptedValue {
  /** Format version, for future key rotation. */
  v: 1;
  iv: string;
  ct: string;
}

export class EncryptionKeyError extends Error {
  constructor() {
    super("SECRETS_ENCRYPTION_KEY must be base64 of exactly 32 bytes");
    this.name = "EncryptionKeyError";
  }
}

const encoder = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

export function importEncryptionKey(raw: string | undefined): Promise<CryptoKey> {
  const trimmed = raw?.trim() ?? "";
  let cached = keyCache.get(trimmed);
  if (!cached) {
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(trimmed);
    } catch {
      throw new EncryptionKeyError();
    }
    if (bytes.byteLength !== 32) throw new EncryptionKeyError();
    cached = crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
    keyCache.set(trimmed, cached);
  }
  return cached;
}

function aad(userId: string, name: string): Uint8Array {
  return encoder.encode(`multix-provider-secret:v1:${userId}:${name}`);
}

export async function encryptSecret(
  key: CryptoKey,
  userId: string,
  name: string,
  value: string,
): Promise<EncryptedValue> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(userId, name) },
    key,
    encoder.encode(value),
  );
  return { v: 1, iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) };
}

export async function decryptSecret(
  key: CryptoKey,
  userId: string,
  name: string,
  record: EncryptedValue,
): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(record.iv), additionalData: aad(userId, name) },
    key,
    base64ToBytes(record.ct),
  );
  return new TextDecoder().decode(plain);
}
