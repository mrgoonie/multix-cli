/**
 * multix remote MCP server for Cloudflare Workers.
 *
 *   GET  /health  public, minimal: { ok, version }
 *   POST /mcp     MCP Streamable HTTP (stateless, JSON responses), bearer auth required
 *
 * The Worker never spawns the CLI and never touches a file system: tools call
 * the runtime-neutral provider HTTP clients and return provider output URLs.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { version } from "../../package.json";
import type { FetchLike } from "../../src/core/fetch-json.js";
import { type Env, MAX_BODY_BYTES, MIN_AUTH_TOKEN_LENGTH, csv } from "./config.js";
import {
  BodyTooLargeError,
  bearerToken,
  originAllowed,
  readBodyLimited,
  tokensMatch,
} from "./http-guards.js";
import { createMcpServer } from "./mcp-server.js";
import { logEvent } from "./redaction.js";

export interface HandlerDeps {
  /** Injected for tests; defaults to the Worker's fetch. */
  fetch?: FetchLike;
}

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...SECURITY_HEADERS, ...headers },
  });
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS, ...headers },
  });
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return json(status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

async function handleMcp(request: Request, env: Env, deps: HandlerDeps): Promise<Response> {
  // Fail closed: without a strong token there is no way to tell callers apart.
  const expected = env.MCP_AUTH_TOKEN?.trim();
  if (!expected || expected.length < MIN_AUTH_TOKEN_LENGTH) {
    logEvent("error", "mcp_not_configured", {});
    return text(503, "Service Unavailable");
  }

  if (!originAllowed(request, csv(env.MULTIX_MCP_ALLOWED_ORIGINS))) {
    return text(403, "Forbidden");
  }

  if (env.MCP_RATE_LIMITER) {
    const key = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.MCP_RATE_LIMITER.limit({ key });
    if (!success) return text(429, "Too Many Requests", { "retry-after": "60" });
  }

  const token = bearerToken(request);
  if (!token || !(await tokensMatch(token, expected))) {
    return text(401, "Unauthorized", { "www-authenticate": 'Bearer realm="multix"' });
  }

  // Stateless server: no standalone SSE stream and no sessions to delete.
  if (request.method !== "POST") {
    return jsonRpcError(405, -32000, "Method not allowed");
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(await readBodyLimited(request, MAX_BODY_BYTES));
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return jsonRpcError(413, -32600, "Request body too large");
    }
    return jsonRpcError(400, -32700, "Parse error");
  }

  const server = createMcpServer(env, { fetch: deps.fetch, version });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, { parsedBody });
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  } finally {
    await server.close();
  }
}

export async function handleRequest(
  request: Request,
  env: Env,
  deps: HandlerDeps = {},
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return text(405, "Method Not Allowed", { allow: "GET, HEAD" });
    }
    return json(200, { ok: true, version });
  }
  if (pathname === "/mcp") return handleMcp(request, env, deps);
  return text(404, "Not Found");
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
