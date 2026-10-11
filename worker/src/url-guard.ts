/**
 * SSRF guard for user-supplied media URLs. Providers fetch these URLs, so
 * only public https hosts by name are accepted: no IP literals, no internal
 * names, no credentials, no non-default ports. (Workers cannot resolve DNS
 * up front, so a public name pointing at a private address is the
 * provider's network boundary, not ours.)
 */

import { ValidationError } from "../../src/core/errors.js";
import { MAX_URL_CHARS } from "./config.js";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".corp",
  ".private",
  ".home.arpa",
  ".in-addr.arpa",
  ".ip6.arpa",
];

/** IPv4 in any form WHATWG URL parsing normalizes to dotted quad, or an IPv6 literal. */
function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith("[")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/** Validate and return a normalized public https URL; throws ValidationError otherwise. */
export function assertPublicHttpsUrl(raw: string, field: string): string {
  if (raw.length > MAX_URL_CHARS) {
    throw new ValidationError(`${field} must be at most ${MAX_URL_CHARS} characters`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(`${field} must be an absolute https:// URL`);
  }
  if (url.protocol !== "https:") throw new ValidationError(`${field} must use https://`);
  if (url.username || url.password) {
    throw new ValidationError(`${field} must not contain credentials`);
  }
  if (url.port !== "") throw new ValidationError(`${field} must use the default https port`);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || isIpLiteral(host)) {
    throw new ValidationError(`${field} must use a public host name, not an IP address`);
  }
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new ValidationError(`${field} points at a private or internal host`);
  }
  return url.toString();
}
