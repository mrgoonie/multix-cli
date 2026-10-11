/**
 * HeyGen webhook signature verification. HeyGen signs the raw request body
 * with HMAC-SHA256 using the endpoint secret and sends the hex digest in the
 * `signature` header (https://developers.heygen.com/docs/webhooks).
 * Uses Web Crypto so it runs unchanged in Node 20+ and Cloudflare Workers.
 */

function toBytes(input: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof input === "string") return new TextEncoder().encode(input);
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim().toLowerCase();
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Constant-time comparison for equal-length byte arrays. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Verify a webhook delivery. Pass the RAW body exactly as received (not
 * re-serialized JSON). Returns false for a missing, malformed, or wrong signature.
 */
export async function verifyHeygenWebhookSignature(
  rawBody: string | Uint8Array | ArrayBuffer,
  signature: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!signature || !secret) return false;
  const provided = hexToBytes(signature);
  if (!provided) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    toBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, toBytes(rawBody)));
  return timingSafeEqual(provided, digest);
}
