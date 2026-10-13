/** Small response builders shared by the MCP endpoint, sign-in routes and dashboard. */

export const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/**
 * Headers for every HTML page: no framing, no scripts, no third-party resources,
 * no referrer sent to other origins. `same-origin` rather than `no-referrer`:
 * under `no-referrer` browsers send `Origin: null` on form POSTs, which the
 * dashboard's and consent page's same-origin check would reject. No `form-action`: browsers apply it to the redirect after
 * the consent POST, which must reach the MCP client's own redirect URI.
 */
export const HTML_SECURITY_HEADERS: Record<string, string> = {
  ...SECURITY_HEADERS,
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src https://avatars.githubusercontent.com; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...SECURITY_HEADERS, ...headers },
  });
}

export function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS, ...headers },
  });
}

export function html(status: number, body: string, headers: HeadersInit = {}): Response {
  const out = new Headers(headers);
  out.set("content-type", "text/html; charset=utf-8");
  for (const [k, v] of Object.entries(HTML_SECURITY_HEADERS)) out.set(k, v);
  return new Response(body, { status, headers: out });
}

/** 303 See Other: the follow-up request is always a GET, even after a form POST. */
export function redirect(location: string, headers: HeadersInit = {}, status = 303): Response {
  const out = new Headers(headers);
  out.set("location", location);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.set(k, v);
  return new Response(null, { status, headers: out });
}

export function jsonRpcError(status: number, code: number, message: string): Response {
  return json(status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

/** Escape a string for HTML text and double-quoted attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
