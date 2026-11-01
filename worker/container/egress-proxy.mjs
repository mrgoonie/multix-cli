/**
 * Egress proxy for job CLI processes run by the self-hosted server.
 *
 * In multix-server the multix CLI runs as a child process in the server's own
 * network namespace, so a URL-valued CLI option the CLI fetches itself (an
 * image or audio URL, for example) could otherwise reach the cloud metadata
 * endpoint, the Kubernetes control plane, cluster services or the server's
 * own database. The Worker checks such options only by host name.
 *
 * The child is started with HTTP(S)_PROXY pointing here (see
 * `proxyEnvFor`). Every connection the proxy opens goes through
 * `createPublicLookup` from job-network.mjs: the name is resolved, the
 * connection is refused when any address is not public, and only the checked
 * addresses are dialled, so DNS rebinding between a check and the connect
 * cannot get through. IP literals are checked directly (Node does not call
 * `lookup` for them).
 *
 * Supported forms: CONNECT tunnels (what Node's fetch uses for both http and
 * https through a proxy, and what ffmpeg and curl use for https) and
 * absolute-form `http://` requests (ffmpeg and curl for plain http). The proxy
 * listens on loopback only and requires a per-process random credential, so
 * other processes cannot use it as a relay.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { connect, isIP } from "node:net";
import { createPublicLookup, isPublicAddress } from "./job-network.mjs";

const PROXY_USER = "multix-job";
const CHALLENGE = `Basic realm="${PROXY_USER}"`;
/** Hop-by-hop headers (RFC 9110 7.6.1) and the proxy credential are never forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const MAX_CONNECTIONS = 256;

export class EgressBlockedError extends Error {
  constructor(host) {
    super(`refusing to connect: ${host} is not a public address`);
    this.name = "EgressBlockedError";
    this.code = "EBLOCKEDADDRESS";
  }
}

/** Split `host:port` / `[v6]:port`; undefined when it is not a valid authority. */
export function parseAuthority(authority) {
  const match = /^(?:\[([0-9A-Fa-f:.]+)\]|([^\s:[\]/@]+)):(\d{1,5})$/.exec(String(authority));
  if (!match) return undefined;
  const host = match[1] ?? match[2];
  const port = Number(match[3]);
  if (!host || port < 1 || port > 65535) return undefined;
  if (match[1] && isIP(host) !== 6) return undefined;
  return { host, port };
}

function stripBrackets(host) {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * The environment a child needs to send all of its HTTP(S) through the proxy:
 * the upper- and lower-case variables (Node, curl, ffmpeg read different
 * ones), no bypass list, and Node's opt-in for env proxies in `fetch`.
 */
export function proxyEnvFor(proxyUrl) {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: "",
    no_proxy: "",
    NODE_USE_ENV_PROXY: "1",
    // Node prints an "EnvHttpProxyAgent is experimental" warning into every job's stderr otherwise.
    NODE_OPTIONS: "--disable-warning=UNDICI-EHPA",
  };
}

/**
 * Start the proxy on 127.0.0.1 (a random port unless `port` is given).
 * @param {{ lookup?: Function, connectTimeoutMs?: number, port?: number }} [options]
 *   `lookup` is injected in tests (a job-network.mjs `createPublicLookup` with a fake resolver).
 * @returns {Promise<{ url: string, port: number, env: Record<string, string>, close(): Promise<void> }>}
 */
export async function startEgressProxy(options = {}) {
  const lookup = options.lookup ?? createPublicLookup();
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const token = randomBytes(24).toString("hex");
  const expected = Buffer.from(`Basic ${Buffer.from(`${PROXY_USER}:${token}`).toString("base64")}`);
  const sockets = new Set();

  function authorized(req) {
    const given = Buffer.from(String(req.headers["proxy-authorization"] ?? ""));
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** Open a TCP connection to a public address only; IP literals are checked here. */
  function dial(host, port, onConnect) {
    const bare = stripBrackets(host);
    if (isIP(bare) && !isPublicAddress(bare)) throw new EgressBlockedError(bare);
    const socket = connect({ host: bare, port, lookup, timeout: connectTimeoutMs });
    track(socket);
    socket.once("connect", () => socket.setTimeout(0));
    socket.once("timeout", () => socket.destroy(new Error("connect timed out")));
    socket.once("connect", onConnect);
    return socket;
  }

  function track(socket) {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  }

  function refuseSocket(client, status, reason, extraHeaders = "") {
    if (client.destroyed) return;
    const body = `${reason}\n`;
    client.end(
      `HTTP/1.1 ${status} ${reason}\r\n${extraHeaders}Content-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  }

  function statusFor(error) {
    return error?.code === "EBLOCKEDADDRESS"
      ? [403, "Forbidden: destination is not a public address"]
      : [502, "Bad Gateway"];
  }

  function handleConnect(req, client, head) {
    track(client);
    client.on("error", () => {});
    if (!authorized(req)) {
      // The challenge matters: ffmpeg sends its credential only after a 407 that asks for it.
      return refuseSocket(
        client,
        407,
        "Proxy Authentication Required",
        `Proxy-Authenticate: ${CHALLENGE}\r\n`,
      );
    }
    const target = parseAuthority(req.url);
    if (!target) return refuseSocket(client, 400, "Bad Request");
    let upstream;
    let established = false;
    try {
      upstream = dial(target.host, target.port, () => {
        established = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
    } catch (error) {
      return refuseSocket(client, ...statusFor(error));
    }
    upstream.on("error", (error) => {
      if (established) client.destroy();
      else refuseSocket(client, ...statusFor(error));
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  }

  function refuseResponse(res, status, reason) {
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { "content-type": "text/plain", connection: "close" });
    res.end(`${reason}\n`);
  }

  /** Absolute-form `GET http://host/path` (plain http from ffmpeg or curl). */
  function handleRequest(req, res) {
    if (!authorized(req)) {
      res.writeHead(407, { "proxy-authenticate": CHALLENGE });
      return res.end();
    }
    let url;
    try {
      url = new URL(req.url);
    } catch {
      return refuseResponse(res, 400, "Bad Request");
    }
    if (url.protocol !== "http:" || url.username || url.password) {
      return refuseResponse(res, 400, "Bad Request");
    }
    const host = stripBrackets(url.hostname);
    if (isIP(host) && !isPublicAddress(host)) {
      return refuseResponse(res, ...statusFor(new EgressBlockedError(host)));
    }
    const headers = {};
    const named = new Set(
      String(req.headers.connection ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase()),
    );
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(name) && !named.has(name) && value !== undefined) headers[name] = value;
    }
    const upstream = httpRequest(
      {
        host,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers,
        lookup,
        agent: false,
        timeout: connectTimeoutMs,
      },
      (upRes) => {
        const out = {};
        for (const [name, value] of Object.entries(upRes.headers)) {
          if (!HOP_BY_HOP.has(name) && value !== undefined) out[name] = value;
        }
        res.writeHead(upRes.statusCode ?? 502, out);
        upRes.pipe(res);
      },
    );
    upstream.once("socket", (socket) => {
      track(socket);
      socket.once("connect", () => upstream.setTimeout(0));
    });
    upstream.on("timeout", () => upstream.destroy(new Error("connect timed out")));
    upstream.on("error", (error) => refuseResponse(res, ...statusFor(error)));
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  }

  const server = createServer(handleRequest);
  server.maxConnections = MAX_CONNECTIONS;
  server.on("connect", handleConnect);
  server.on("connection", track);
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address();
  const url = `http://${PROXY_USER}:${token}@127.0.0.1:${port}`;

  let closing;
  return {
    url,
    port,
    env: proxyEnvFor(url),
    close() {
      closing ??= new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}
