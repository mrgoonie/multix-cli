/**
 * The node:http listener of the standalone server: each request goes
 * through node-http-bridge.ts into the app, with a body size cap and
 * in-flight tracking for graceful shutdown.
 */

import { type Server, createServer } from "node:http";
import { logEvent } from "../src/redaction.js";
import { BodyTooLargeError, toFetchRequest, writeFetchResponse } from "./node-http-bridge.js";
import type { StandaloneApp } from "./standalone-app.js";

export interface HttpServerOptions {
  /** Public origin every request URL is rebuilt on. */
  origin: string;
  trustProxyHops: number;
  maxBodyBytes: number;
}

export interface MultixHttpServer {
  server: Server;
  inFlight(): number;
  /** Stop accepting, wait up to `timeoutMs` for open requests, then close every connection. */
  close(timeoutMs: number): Promise<void>;
}

function isTooLarge(error: unknown): boolean {
  return (
    error instanceof BodyTooLargeError ||
    (error instanceof Error && error.cause instanceof BodyTooLargeError)
  );
}

export function createHttpServer(app: StandaloneApp, options: HttpServerOptions): MultixHttpServer {
  let inFlight = 0;
  const server = createServer(async (req, res) => {
    inFlight++;
    const abort = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) abort.abort();
      inFlight--;
    });
    try {
      const request = toFetchRequest(req, options.origin, {
        trustedHops: options.trustProxyHops,
        maxBodyBytes: options.maxBodyBytes,
        signal: abort.signal,
      });
      const response = await app.fetch(request);
      await writeFetchResponse(response, res, request.method);
    } catch (error) {
      const tooLarge = isTooLarge(error);
      if (!tooLarge) {
        logEvent("error", "request_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
      if (!res.headersSent) {
        res.writeHead(tooLarge ? 413 : 500, { "content-type": "text/plain; charset=utf-8" });
        res.end(tooLarge ? "Payload Too Large" : "Internal Server Error");
      } else {
        res.destroy();
      }
    }
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 300_000;
  server.keepAliveTimeout = 65_000;
  return {
    server,
    inFlight: () => inFlight,
    async close(timeoutMs) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const deadline = Date.now() + timeoutMs;
      while (inFlight > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      server.closeAllConnections();
      await closed;
    },
  };
}
