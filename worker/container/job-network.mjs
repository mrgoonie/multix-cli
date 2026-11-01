/**
 * Outbound HTTPS for job inputs with the address check done at connect time.
 *
 * The host name check in job-inputs.mjs is not enough on its own: a public
 * name can resolve to a private, loopback or link-local address (DNS
 * rebinding, wildcard DNS). `publicLookup` resolves the name, refuses the
 * connection when any address is not public, and hands only the checked
 * addresses to the socket, so the address that was checked is the one that
 * is connected to. Every redirect hop is a new request and is checked again.
 */

import { lookup as dnsLookup } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import { Readable, pipeline } from "node:stream";

export class BlockedAddressError extends Error {
  constructor() {
    super("Input URL must resolve to a public address");
    this.name = "BlockedAddressError";
    this.code = "EBLOCKEDADDRESS";
  }
}

function v4Octets(ip) {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : undefined;
}

function isPublicV4(ip) {
  const o = v4Octets(ip);
  if (!o) return false;
  const [a, b, c] = o;
  if (a === 0 || a === 10 || a === 127) return false; // this network, RFC 1918, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC 1918
  if (a === 192 && b === 168) return false; // RFC 1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Expand an IPv6 address into 8 16-bit groups (handles `::` and a dotted IPv4 tail). */
function v6Groups(ip) {
  let text = ip.toLowerCase().split("%")[0];
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const o = v4Octets(dotted[1]);
    if (!o) return undefined;
    const tail = `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
    text = text.slice(0, -dotted[1].length) + tail;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...rest].map((g) =>
    Number.parseInt(g, 16),
  );
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : undefined;
}

function embeddedV4(groups) {
  const [g6, g7] = [groups[6], groups[7]];
  return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
}

/** Same rules as the Worker's save-time check (worker/src/events/callback-guard.ts). */
function isPublicV6(ip) {
  const g = v6Groups(ip);
  if (!g) return false;
  const zeroHead = g.slice(0, 5).every((x) => x === 0);
  if (zeroHead && g[5] === 0xffff) return isPublicV4(embeddedV4(g)); // ::ffff:a.b.c.d
  if (zeroHead) return false; // ::, ::1 and the deprecated IPv4-compatible range
  if (g[0] === 0x64 && g[1] === 0xff9b) return false; // NAT64 can reach internal IPv4
  if ((g[0] & 0xe000) !== 0x2000) return false; // only 2000::/3 is global unicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo
  if (g[0] === 0x2001 && g[1] === 2 && g[2] === 0) return false; // benchmarking 2001:2::/48
  if (g[0] === 0x2001 && g[1] >= 0x10 && g[1] <= 0x2f) return false; // ORCHID
  if (g[0] === 0x3fff && g[1] <= 0x0fff) return false; // documentation 3fff::/20
  if (g[0] === 0x2002) return false; // 6to4 embeds an arbitrary IPv4
  return true;
}

/** True only for a globally routable unicast address. */
export function isPublicAddress(ip) {
  const family = isIP(String(ip));
  if (family === 4) return isPublicV4(ip);
  if (family === 6) return isPublicV6(ip);
  return false;
}

/**
 * `lookup` for net/https: resolve every address, refuse the connection when
 * any of them is not public, and connect only to the checked addresses.
 * @param {typeof dnsLookup} [resolve] injected in tests
 */
export function createPublicLookup(resolve = dnsLookup) {
  return (hostname, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "object" && options !== null ? options : {};
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return cb(error);
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
        return cb(new BlockedAddressError());
      }
      if (opts.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function toHeaders(raw) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    try {
      for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
    } catch {
      // Skip a header value the Headers class rejects.
    }
  }
  return headers;
}

/** Node request body from a fetch-style body: web stream, bytes, string or none. */
function toNodeBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || body instanceof Uint8Array) return Readable.from([body]);
  if (body instanceof ReadableStream) return Readable.fromWeb(body);
  throw new TypeError("Unsupported request body");
}

/**
 * fetch-compatible HTTPS request (no redirects) whose connection may only
 * reach public addresses, checked by `publicLookup` at connect time. Used to
 * upload outputs to a custom S3-compatible endpoint, whose name the account
 * chose: a name re-pointed at a private address after the dashboard checked
 * it is refused here.
 * @param {string | URL} input
 * `lookup` and `ca` are injected in tests.
 * @param {{ method?: string, headers?: HeadersInit, body?: ReadableStream | Uint8Array | string, signal?: AbortSignal, lookup?: Function, ca?: string }} [init]
 */
export function publicHttpsFetch(input, init = {}) {
  const url = new URL(String(input));
  if (url.protocol !== "https:") return Promise.reject(new TypeError("Only https is allowed"));
  const lookup = init.lookup ?? createPublicLookup();
  const headers = {};
  for (const [name, value] of new Headers(init.headers)) headers[name] = value;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method ?? "GET",
        agent: false,
        lookup,
        signal: init.signal,
        headers,
        ...(init.ca ? { ca: init.ca } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 502;
        if (status < 200 || status > 599 || NULL_BODY_STATUSES.has(status)) {
          res.resume();
          resolve(new Response(null, { status: status < 200 || status > 599 ? 502 : status }));
          return;
        }
        resolve(new Response(Readable.toWeb(res), { status, headers: toHeaders(res.headers) }));
      },
    );
    req.on("error", reject);
    let body;
    try {
      body = toNodeBody(init.body);
    } catch (error) {
      req.destroy();
      reject(error);
      return;
    }
    if (!body) {
      req.end();
      return;
    }
    // pipeline closes the source (an open output file) when the request fails.
    pipeline(body, req, (error) => {
      if (error) req.destroy(error);
    });
  });
}

/**
 * One GET without following redirects, connected through `publicLookup`.
 * Resolves to a standard Response so callers handle it like fetch().
 * @param {URL} url
 * @param {{ signal?: AbortSignal, lookup?: Function }} [options]
 */
export function publicHttpsGet(url, options = {}) {
  const lookup = options.lookup ?? createPublicLookup();
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        agent: false,
        lookup,
        signal: options.signal,
        headers: { "user-agent": "multix-job", accept: "*/*" },
      },
      (res) => {
        const status = res.statusCode ?? 502;
        if (status < 200 || status > 599 || NULL_BODY_STATUSES.has(status)) {
          res.resume();
          resolve(new Response(null, { status: status < 200 || status > 599 ? 502 : status }));
          return;
        }
        resolve(new Response(Readable.toWeb(res), { status, headers: toHeaders(res.headers) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
