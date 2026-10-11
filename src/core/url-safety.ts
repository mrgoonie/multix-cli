/**
 * URL safety policy for downloading provider-supplied URLs (output files,
 * redirect targets). Runtime-neutral: no node:* imports, so provider clients
 * that also run outside Node can share it.
 *
 * The check works on the URL's literal host only. Hostnames are not resolved,
 * so a public name whose DNS record points at a private address is not caught;
 * the https-only rule (certificate verification) is what limits that case.
 */

import { ProviderError } from "./errors.js";

/** Validates a URL before it is fetched; throw (or reject) to refuse it. */
export type UrlValidator = (url: string) => void | Promise<void>;

export interface UrlSafetyOptions {
  /** Provider name carried by the thrown ProviderError. */
  provider: string;
  /** Hosts reported as trusted, together with their subdomains. */
  trustedHosts?: readonly string[];
  /** Also allow http:// and https:// to localhost or a loopback literal (local dev servers). */
  allowLocalhostHttp?: boolean;
  /** Verb phrase used in refusal messages. Default: "download from". */
  action?: string;
}

export interface UrlSafetyResult {
  /** Lowercased hostname without a trailing dot. Safe to log (no path or query string). */
  host: string;
  /** True when the host is one of `trustedHosts` or a subdomain of one. */
  trusted: boolean;
}

/** Octets of a dotted-quad IPv4 literal (as normalized by the WHATWG URL parser). */
function ipv4Octets(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return undefined;
  const octets = parts.map(Number);
  return octets.every((o) => o <= 255) ? octets : undefined;
}

function isNonPublicIpv4([a = 0, b = 0, c = 0]: number[]): boolean {
  return (
    a === 0 || // "this network" / unspecified
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast and reserved
  );
}

/** Eight 16-bit groups of an IPv6 literal, or undefined when it is not one. */
function ipv6Groups(host: string): number[] | undefined {
  if (!/^[0-9a-f:.]+$/i.test(host) || !host.includes(":")) return undefined;
  let text = host;
  // A trailing dotted IPv4 tail becomes two hex groups.
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const octets = ipv4Octets(tail[2] as string);
    if (!octets) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (s: string) => (s === "" ? [] : s.split(":"));
  const head = parse(halves[0] as string);
  const rest = halves.length === 2 ? parse(halves[1] as string) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  return all.map((g) => Number.parseInt(g, 16));
}

function embeddedIpv4(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function isNonPublicIpv6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const zeroUpTo = (n: number) => groups.slice(0, n).every((g) => g === 0);
  // IPv4-mapped ::ffff:a.b.c.d: judge the embedded IPv4 address.
  if (zeroUpTo(5) && g5 === 0xffff) return isNonPublicIpv4(embeddedIpv4(g6, g7));
  // NAT64 64:ff9b::/96: judge the embedded IPv4 address.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isNonPublicIpv4(embeddedIpv4(g6, g7));
  }
  // 6to4 2002::/16 carries an IPv4 address in groups 1-2.
  if (g0 === 0x2002) return isNonPublicIpv4(embeddedIpv4(g1, g2));
  return (
    g0 === 0 || // unspecified (::), loopback (::1), IPv4-compatible and other reserved
    (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) || // discard-only 100::/64
    (g0 & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (g0 & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (g0 & 0xffc0) === 0xfec0 || // deprecated site-local fec0::/10
    (g0 & 0xff00) === 0xff00 // multicast
  );
}

function bareHost(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** localhost, *.localhost, or a loopback IP literal (127.0.0.0/8, ::1). */
export function isLoopbackHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const octets = ipv4Octets(host);
  if (octets) return octets[0] === 127;
  const groups = ipv6Groups(host);
  if (!groups) return false;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return groups[6] !== undefined && groups[6] >> 8 === 127;
  }
  return groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
}

/**
 * True for localhost names and for loopback, private, link-local, unspecified,
 * documentation, benchmarking, multicast, and other special-purpose IP
 * literals (IPv4, IPv6, and IPv4 embedded in IPv6). Pass a URL's `hostname`
 * (brackets around IPv6 are accepted). Names are not resolved.
 */
export function isNonPublicHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const octets = ipv4Octets(host);
  if (octets) return isNonPublicIpv4(octets);
  const groups = ipv6Groups(host);
  return groups !== undefined && isNonPublicIpv6(groups);
}

/**
 * Apply the download policy to one URL (call it for every redirect hop):
 * https only, never localhost or a non-public IP literal, unless
 * `allowLocalhostHttp` permits a loopback target. Other public hosts are
 * allowed and reported as untrusted unless listed in `trustedHosts`, so the
 * caller can warn. Messages name the host only, never the path or query.
 */
export function checkUrlSafety(url: string, opts: UrlSafetyOptions): UrlSafetyResult {
  const action = opts.action ?? "download from";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProviderError(`Refusing to ${action} a malformed URL`, opts.provider);
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const localOk = opts.allowLocalhostHttp === true && isLoopbackHost(host);
  const httpOk = parsed.protocol === "https:" || (localOk && parsed.protocol === "http:");
  if (!httpOk) {
    throw new ProviderError(
      `Refusing to ${action} ${host || "this URL"}: only https:// URLs are allowed`,
      opts.provider,
    );
  }
  if (!localOk && isNonPublicHost(host)) {
    throw new ProviderError(
      `Refusing to ${action} ${host}: it points to a local or private address`,
      opts.provider,
    );
  }
  const trusted = (opts.trustedHosts ?? []).some((t) => host === t || host.endsWith(`.${t}`));
  return { host, trusted };
}
