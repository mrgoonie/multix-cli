/**
 * A subscription is identified by (principal, callback URL, event name,
 * arguments). Subscribing again with the same identity refreshes the existing
 * subscription instead of adding one, and unsubscribe finds it the same way.
 * Arguments compare as canonical JSON, so key order never creates a second
 * subscription.
 */

/** JSON with object keys sorted at every level (RFC 8785 for the values MCP arguments carry). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export interface SubscriptionIdentity {
  principal: string;
  url: string;
  name: string;
  arguments: Record<string, unknown>;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `sub_` + 24 hex characters of SHA-256 over the canonical identity. A routing handle, not a credential. */
export async function subscriptionId(identity: SubscriptionIdentity): Promise<string> {
  const key = canonicalJson([identity.principal, identity.url, identity.name, identity.arguments]);
  return `sub_${(await sha256Hex(key)).slice(0, 24)}`;
}
