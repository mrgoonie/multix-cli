/**
 * Converts between node:http and the Fetch API objects the Worker handler
 * takes. The request URL is rebuilt on the configured public origin
 * (MULTIX_PUBLIC_URL), never on the Host or X-Forwarded-* headers, so OAuth
 * metadata, redirect URIs and Origin checks cannot be steered by a client.
 *
 * `cf-connecting-ip` is what the Worker reads for the client address (per-IP
 * sign-in rate limits). Any client-sent copy is dropped and replaced with the
 * socket address, or with the address the trusted proxy hops report in
 * X-Forwarded-For when MULTIX_TRUST_PROXY_HOPS is set.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";

/** Hop-by-hop headers that must not be forwarded in either direction. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
]);

/** Headers only the edge sets on Cloudflare; a client must not be able to forge them here. */
const EDGE_HEADERS = ["cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "true-client-ip"];

export class BodyTooLargeError extends Error {
  override name = "BodyTooLargeError";
}

/**
 * The client address: the socket peer, or with `trustedHops` > 0 the entry
 * that many hops from the right of X-Forwarded-For (each trusted proxy
 * appends the address it received the request from).
 */
export function clientAddress(req: IncomingMessage, trustedHops: number): string {
  const peer = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
  if (trustedHops <= 0) return peer;
  const header = req.headers["x-forwarded-for"];
  const raw = Array.isArray(header) ? header.join(",") : (header ?? "");
  const chain = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const candidate = chain[chain.length - trustedHops];
  const cleaned = candidate?.replace(/^::ffff:/, "");
  return cleaned && isIP(cleaned) ? cleaned : peer;
}

export function toFetchRequest(
  req: IncomingMessage,
  origin: string,
  options: { trustedHops: number; maxBodyBytes: number; signal: AbortSignal },
): Request {
  const path = req.url?.startsWith("/") ? req.url : "/";
  const url = new URL(path, origin);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(lower) || EDGE_HEADERS.includes(lower)) continue;
    if (lower === "host") continue;
    if (Array.isArray(value)) for (const v of value) headers.append(lower, v);
    else headers.set(lower, value);
  }
  headers.set("host", url.host);
  headers.set("cf-connecting-ip", clientAddress(req, options.trustedHops));

  const method = (req.method ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const declared = Number(req.headers["content-length"] ?? Number.NaN);
  if (hasBody && Number.isFinite(declared) && declared > options.maxBodyBytes) {
    throw new BodyTooLargeError("request body too large");
  }
  let body: ReadableStream<Uint8Array> | undefined;
  if (hasBody) {
    let seen = 0;
    const limited = Readable.from(
      (async function* () {
        for await (const chunk of req) {
          seen += (chunk as Buffer).length;
          if (seen > options.maxBodyBytes) throw new BodyTooLargeError("request body too large");
          yield chunk as Buffer;
        }
      })(),
    );
    body = Readable.toWeb(limited) as ReadableStream<Uint8Array>;
  }
  return new Request(url, {
    method,
    headers,
    body,
    signal: options.signal,
    ...(body ? { duplex: "half" } : {}),
  } as RequestInit);
}

export async function writeFetchResponse(
  response: Response,
  res: ServerResponse,
  method: string,
): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  const cookies = response.headers.getSetCookie();
  response.headers.forEach((value, name) => {
    if (HOP_BY_HOP.has(name) || name === "set-cookie") return;
    headers[name] = value;
  });
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  res.writeHead(response.status, response.statusText || undefined, headers);
  if (method === "HEAD" || !response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  const onClose = () => {
    reader.cancel().catch(() => undefined);
  };
  res.once("close", onClose);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.once("drain", done);
          res.once("close", done);
        });
      }
      if (res.destroyed) break;
    }
  } finally {
    res.off("close", onClose);
    res.end();
  }
}
