/**
 * /mcp after authentication: MCP Streamable HTTP (stateless, JSON responses).
 *
 * The OAuth layer (index.ts) has already validated the access token and
 * resolved the caller's own provider keys into `env`; this module only checks
 * the browser Origin, bounds the request and runs one MCP exchange.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { version } from "../../package.json";
import type { FetchLike } from "../../src/core/fetch-json.js";
import { type Env, MAX_BODY_BYTES, csv } from "./config.js";
import { BodyTooLargeError, originAllowed, readBodyLimited } from "./http-guards.js";
import { SECURITY_HEADERS, jsonRpcError, text } from "./http-responses.js";
import type { JobToolsContext } from "./jobs/job-runner.js";
import { createMcpServer } from "./mcp-server.js";

export interface McpDeps {
  /** Injected for tests; defaults to the Worker's fetch. */
  fetch?: FetchLike;
  /** The caller's job context for the CLI runner tools (absent = tools not offered). */
  jobs?: JobToolsContext;
}

/** CORS headers for an allowed browser Origin; empty for non-browser callers. */
function corsHeaders(origin: string | null): Record<string, string> {
  if (origin === null) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-expose-headers": "www-authenticate, retry-after",
    vary: "Origin",
  };
}

function withHeaders(response: Response, extra: Record<string, string>): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

export async function handleMcpRequest(
  request: Request,
  env: Env,
  deps: McpDeps = {},
): Promise<Response> {
  // DNS-rebinding protection: a browser Origin must be explicitly allowed.
  if (!originAllowed(request, csv(env.MULTIX_MCP_ALLOWED_ORIGINS))) {
    return text(403, "Forbidden", { "access-control-allow-origin": "null" });
  }
  const cors = corsHeaders(request.headers.get("origin"));

  // Stateless server: no standalone SSE stream and no sessions to delete.
  if (request.method !== "POST") {
    return withHeaders(jsonRpcError(405, -32000, "Method not allowed"), cors);
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(await readBodyLimited(request, MAX_BODY_BYTES));
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return withHeaders(jsonRpcError(413, -32600, "Request body too large"), cors);
    }
    return withHeaders(jsonRpcError(400, -32700, "Parse error"), cors);
  }
  // One HTTP request must be one JSON-RPC message, so the rate limit also bounds
  // tool calls. Batching was removed from MCP in protocol 2025-06-18.
  if (Array.isArray(parsedBody)) {
    return withHeaders(jsonRpcError(400, -32600, "Batch requests are not supported"), cors);
  }

  const server = createMcpServer(env, { fetch: deps.fetch, version, jobs: deps.jobs });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, { parsedBody });
    return withHeaders(response, { ...SECURITY_HEADERS, ...cors });
  } finally {
    await server.close();
  }
}
