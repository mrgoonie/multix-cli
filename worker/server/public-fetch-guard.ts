/**
 * Node equivalent of the Worker's `global_fetch_strictly_public` flag: every
 * outbound `fetch` of the server (GitHub sign-in, MCP client metadata
 * documents, provider APIs, R2 checks, event webhooks) may only connect to
 * public unicast addresses. The check runs on the address actually dialled
 * (an undici connector with a filtering DNS lookup, and IP literals checked
 * directly), so DNS rebinding between a check and the connection cannot
 * reach loopback, link-local metadata or private networks.
 */

import { type LookupAddress, lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, buildConnector } from "undici";
import { isNonPublicIpv4, isNonPublicIpv6 } from "../src/events/callback-guard.js";
import { releaseTurnDuring } from "./durable-object-host.js";

export class NonPublicAddressError extends Error {
  override name = "NonPublicAddressError";
  readonly code = "ERR_MULTIX_NON_PUBLIC_ADDRESS";
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !isNonPublicIpv4(address);
  if (family === 6) return !isNonPublicIpv6(address);
  return false;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** dns.lookup that fails unless every resolved address is public. */
export function publicOnlyLookup(
  hostname: string,
  options: { all?: boolean; family?: number } | number,
  callback: LookupCallback,
): void {
  const opts = typeof options === "number" ? { family: options } : options;
  dnsLookup(hostname, { family: opts.family ?? 0, all: true }, (error, addresses) => {
    if (error) return callback(error, opts.all ? [] : "");
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      return callback(
        new NonPublicAddressError(
          `refusing to connect: ${hostname} resolves to a non-public address`,
        ),
        opts.all ? [] : "",
      );
    }
    if (opts.all) return callback(null, list);
    const first = list[0] as LookupAddress;
    callback(null, first.address, first.family);
  });
}

/** An undici Agent whose connections only reach public addresses. */
export function publicOnlyAgent(): Agent {
  const connect = buildConnector({ lookup: publicOnlyLookup as never });
  return new Agent({
    connect(options, callback) {
      const host = options.hostname.replace(/^\[|\]$/g, "");
      if (isIP(host) && !isPublicAddress(host)) {
        callback(
          new NonPublicAddressError(`refusing to connect to non-public address ${host}`),
          null,
        );
        return;
      }
      connect(options, callback);
    },
  });
}

/**
 * Replace globalThis.fetch with one that always uses the public-only agent.
 * The caller's `dispatcher` option is ignored so no code path can opt out.
 * Inside a Durable Object turn the instance lock is given up while the
 * request is out (see releaseTurnDuring).
 */
export function installPublicFetchGuard(): Agent {
  const agent = publicOnlyAgent();
  const original = globalThis.fetch;
  const guarded = (input: RequestInfo | URL, init?: RequestInit) =>
    releaseTurnDuring(() => original(input, { ...(init ?? {}), dispatcher: agent } as RequestInit));
  globalThis.fetch = guarded as typeof fetch;
  // What workers-oauth-provider checks before it fetches MCP Client ID
  // Metadata Documents: claim the flag only once the guard is in place.
  (globalThis as { Cloudflare?: unknown }).Cloudflare = {
    compatibilityFlags: { global_fetch_strictly_public: true },
  };
  return agent;
}
