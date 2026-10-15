/**
 * Standard Webhooks signing (https://www.standardwebhooks.com), the scheme
 * MCP Events uses for verification and event deliveries:
 *
 *   webhook-signature = "v1," + base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`))
 *
 * The key is the base64 part of a `whsec_` secret. The subscriber generates
 * the secret; it must decode to 24-64 bytes.
 */

import { base64ToBytes, bytesToBase64 } from "../accounts/base64.js";

export const SECRET_PREFIX = "whsec_";
const MIN_SECRET_BYTES = 24;
const MAX_SECRET_BYTES = 64;
/** Longest accepted secret string: prefix plus base64 of 64 bytes, with some slack. */
export const MAX_SECRET_CHARS = 128;

const encoder = new TextEncoder();

/** The HMAC key bytes of a valid `whsec_` secret, or null when the secret is malformed. */
export function secretKeyBytes(secret: string): Uint8Array | null {
  if (secret.length > MAX_SECRET_CHARS || !secret.startsWith(SECRET_PREFIX)) return null;
  const encoded = secret.slice(SECRET_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(encoded);
  } catch {
    return null;
  }
  return bytes.byteLength >= MIN_SECRET_BYTES && bytes.byteLength <= MAX_SECRET_BYTES
    ? bytes
    : null;
}

export function isValidSecret(secret: string): boolean {
  return secretKeyBytes(secret) !== null;
}

/** One `v1,<base64>` signature of `body` under `secret` (throws on a malformed secret). */
export async function signWebhook(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const keyBytes = secretKeyBytes(secret);
  if (!keyBytes) throw new Error("Malformed webhook secret");
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${id}.${timestamp}.${body}`));
  return `v1,${bytesToBase64(new Uint8Array(mac))}`;
}

/**
 * The webhook headers for one attempt. Several secrets (a rotation window)
 * give space-separated signatures; receivers accept any one of them.
 */
export async function webhookHeaders(
  secrets: string[],
  id: string,
  timestamp: number,
  body: string,
  subscriptionId: string,
): Promise<Record<string, string>> {
  const signatures = await Promise.all(secrets.map((s) => signWebhook(s, id, timestamp, body)));
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signatures.join(" "),
    "x-mcp-subscription-id": subscriptionId,
  };
}
