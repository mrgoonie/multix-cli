/**
 * Secret redaction helpers. Runtime-neutral (no node:* imports) so they can be
 * shared by the CLI and non-Node runtimes such as a Cloudflare Worker.
 */

/**
 * Redact an API key for safe logging: show first 6 + last 4 chars.
 * e.g. "AIzaSy...abcd"
 */
export function redact(key: string): string {
  if (key.length <= 10) return "***";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

/**
 * Strip the query string and fragment from a URL so API keys passed as query
 * parameters and pre-signed media tokens never reach logs or error messages.
 * Opaque URLs (data:, blob:, file:) collapse to their scheme. Secrets embedded
 * in the path itself are not detected. Non-URL input is returned unchanged
 * except for anything after "?" or "#".
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.origin === "null") return `${u.protocol}[redacted]`;
    const suffix = u.search || u.hash ? "?[redacted]" : "";
    return `${u.origin}${u.pathname}${suffix}`;
  } catch {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : `${url.slice(0, cut)}?[redacted]`;
  }
}
