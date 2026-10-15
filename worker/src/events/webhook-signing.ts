/**
 * Standard Webhooks signatures (https://www.standardwebhooks.com): each
 * delivery carries `webhook-id`, `webhook-timestamp` (Unix seconds) and
 * `webhook-signature: v1,<base64 HMAC-SHA256(secret, "<id>.<timestamp>.<body>")>`.
 * The secret is `whsec_` + base64 of 32 random bytes and is shown once, when
 * the subscription is created. Receivers reject stale timestamps and
 * already-seen ids, which stops replays.
 */

import { base64ToBytes, bytesToBase64 } from "../accounts/base64.js";

export const SECRET_PREFIX = "whsec_";
/** Receivers should reject deliveries older or newer than this (Standard Webhooks default). */
export const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export function generateWebhookSecret(): string {
  return `${SECRET_PREFIX}${bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))}`;
}

function secretBytes(secret: string): Uint8Array {
  return base64ToBytes(
    secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret,
  );
}

async function hmac(secret: string, content: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content));
  return bytesToBase64(new Uint8Array(mac));
}

export async function signWebhook(
  secret: string,
  id: string,
  timestampSeconds: number,
  body: string,
): Promise<string> {
  return `v1,${await hmac(secret, `${id}.${timestampSeconds}.${body}`)}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Receiver-side check: a fresh timestamp and one matching `v1` signature. */
export async function verifyWebhook(
  secret: string,
  headers: { id: string; timestamp: string; signature: string },
  body: string,
  nowSeconds: number,
  toleranceSeconds = TIMESTAMP_TOLERANCE_SECONDS,
): Promise<boolean> {
  const timestamp = Number(headers.timestamp);
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return false;
  }
  const expected = await signWebhook(secret, headers.id, timestamp, body);
  return headers.signature.split(" ").some((candidate) => constantTimeEqual(candidate, expected));
}

/** MCP Events subscribers choose their secret; it must decode to this many bytes. */
const MIN_CLIENT_SECRET_BYTES = 24;
const MAX_CLIENT_SECRET_BYTES = 64;
/** Longest accepted client secret: prefix plus base64 of 64 bytes, with some slack. */
export const MAX_SECRET_CHARS = 128;

/** Whether a client-chosen secret is `whsec_` + canonical base64 of 24-64 bytes. */
export function isValidSecret(secret: string): boolean {
  if (secret.length > MAX_SECRET_CHARS || !secret.startsWith(SECRET_PREFIX)) return false;
  const encoded = secret.slice(SECRET_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  try {
    const bytes = base64ToBytes(encoded).byteLength;
    return bytes >= MIN_CLIENT_SECRET_BYTES && bytes <= MAX_CLIENT_SECRET_BYTES;
  } catch {
    return false;
  }
}

/**
 * The headers of an MCP Events request (verification or delivery). Several
 * secrets (a rotation window) give space-separated signatures; receivers
 * accept any one of them.
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
