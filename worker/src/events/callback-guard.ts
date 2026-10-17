/**
 * SSRF checks for event callback URLs (REST subscriptions and MCP Events),
 * applied at subscribe time and again by EventHub before every delivery:
 *
 * - the URL must be a public https URL by host name (url-guard.ts: no IP
 *   literals, credentials, custom ports or internal names);
 * - every A/AAAA record of the host, resolved over DNS-over-HTTPS, must be a
 *   public unicast address.
 *
 * The Worker cannot pin the connection to the address it checked, so a name
 * re-pointed between this check and the connection (DNS rebinding) is not
 * caught here; `global_fetch_strictly_public` only routes fetches to the
 * Worker's own zone over the internet and is not an address filter. Every later
 * request to the callback (verification, deliveries) must therefore repeat this
 * check right before it connects. Callback fetches never follow redirects.
 */

import type { FetchLike } from "../../../src/core/fetch-json.js";
import { assertPublicHttpsUrl } from "../url-guard.js";

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DNS_TIMEOUT_MS = 5_000;
const RECORD_A = 1;
const RECORD_AAAA = 28;

/** The callback host cannot be checked (DNS-over-HTTPS failed); retrying later may work. */
export class CallbackDnsError extends Error {
  constructor() {
    super("Could not resolve the callback host");
    this.name = "CallbackDnsError";
  }
}

/** The callback URL or its addresses are not allowed; the caller sent invalid params. */
export class CallbackUrlError extends Error {
  constructor(
    message: string,
    /** `invalid`: refused by name; `unresolved`: no A/AAAA record; `not_public`: a non-public address. */
    readonly reason: "invalid" | "unresolved" | "not_public" = "invalid",
  ) {
    super(message);
    this.name = "CallbackUrlError";
  }
}

function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

/** True for any address that is not public unicast IPv4. */
export function isNonPublicIpv4(address: string): boolean {
  const o = ipv4Octets(address);
  if (!o) return true;
  const [a, b, c] = o as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 31 && c === 196) ||
    (a === 192 && b === 52 && c === 193) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 175 && c === 48) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** The eight 16-bit groups of an IPv6 address (embedded IPv4 tail allowed), or null. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase();
  const v4 = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const o = ipv4Octets(v4[2] as string);
    if (!o) return null;
    text = `${v4[1]}${((o[0] as number) * 256 + (o[1] as number)).toString(16)}:${((o[2] as number) * 256 + (o[3] as number)).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0] as string);
  const tail = halves.length === 2 ? parse(halves[1] as string) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => Number.parseInt(g, 16));
}

/** True for any address that is not global unicast IPv6 (or maps onto a non-public IPv4). */
export function isNonPublicIpv6(address: string): boolean {
  const g = ipv6Groups(address);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const v4Tail = `${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`;
  const zeroHead = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroHead && g5 === 0xffff) return isNonPublicIpv4(v4Tail); // ::ffff:a.b.c.d
  if (zeroHead) return true; // ::, ::1 and the deprecated IPv4-compatible range
  if (g0 === 0x64 && g1 === 0xff9b) return true; // NAT64 can reach internal IPv4
  if ((g0 & 0xe000) !== 0x2000) return true; // only 2000::/3 is global unicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo
  if (g0 === 0x2001 && g1 === 2 && g2 === 0) return true; // benchmarking 2001:2::/48
  if (g0 === 0x2001 && g1 >= 0x10 && g1 <= 0x2f) return true; // ORCHID 2001:10::/28, 2001:20::/28
  if (g0 === 0x3fff && g1 <= 0x0fff) return true; // documentation 3fff::/20
  if (g0 === 0x2002) return true; // 6to4 embeds an arbitrary IPv4
  return false;
}

interface DohAnswer {
  type?: number;
  data?: string;
}

async function resolve(fetchFn: FetchLike, host: string, type: "A" | "AAAA"): Promise<string[]> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`;
  let body: { Status?: number; Answer?: DohAnswer[] };
  try {
    const response = await fetchFn(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
    });
    if (!response.ok) throw new CallbackDnsError();
    body = (await response.json()) as typeof body;
  } catch {
    throw new CallbackDnsError();
  }
  // 3 = NXDOMAIN: no addresses. Any other failure status means we could not tell.
  if (body.Status === 3) return [];
  if (body.Status !== 0) throw new CallbackDnsError();
  const wanted = type === "A" ? RECORD_A : RECORD_AAAA;
  return (body.Answer ?? [])
    .filter((a) => a.type === wanted && typeof a.data === "string")
    .map((a) => a.data as string);
}

/**
 * The normalized callback URL when it is a public https URL whose host
 * resolves only to public addresses. Throws CallbackUrlError (invalid params)
 * or CallbackDnsError (could not check).
 */
export async function assertPublicCallbackUrl(
  raw: string,
  fetchFn: FetchLike,
  field = "delivery.url",
): Promise<string> {
  let normalized: string;
  try {
    normalized = assertPublicHttpsUrl(raw, field);
  } catch (error) {
    throw new CallbackUrlError(error instanceof Error ? error.message : `Invalid ${field}`);
  }
  const host = new URL(normalized).hostname.replace(/\.$/, "");
  const [v4, v6] = await Promise.all([resolve(fetchFn, host, "A"), resolve(fetchFn, host, "AAAA")]);
  if (v4.length === 0 && v6.length === 0) {
    throw new CallbackUrlError(`${field} host does not resolve`, "unresolved");
  }
  if (v4.some(isNonPublicIpv4) || v6.some(isNonPublicIpv6)) {
    throw new CallbackUrlError(`${field} resolves to a private or reserved address`, "not_public");
  }
  return normalized;
}
