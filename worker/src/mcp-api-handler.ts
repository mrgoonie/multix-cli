/**
 * /mcp after authentication: MCP Streamable HTTP (stateless, JSON responses).
 *
 * The OAuth layer (index.ts) has already validated the access token and
 * resolved the caller's own provider keys into `env`; this module only checks
 * the browser Origin, bounds the request and runs one MCP exchange.
 *
 * Two protocol eras share the endpoint. Requests carrying the per-request
 * `_meta` protocol envelope (2026-07-28, negotiated through server/discover)
 * go to the SDK's modern handler, which also offers MCP Events. Everything
 * else (the 2025 initialize handshake and its follow-up calls) is served by
 * the same stateless transport as before, so existing clients see no change.
 */

import {
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isJsonContentType,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import { version } from "../../package.json";
import { type Env, MAX_BODY_BYTES, csv } from "./config.js";
import type { EventsContext } from "./events/events-methods.js";
import { BodyTooLargeError, originAllowed, readBodyLimited } from "./http-guards.js";
import { SECURITY_HEADERS, jsonRpcError, text } from "./http-responses.js";
import type { JobToolsContext } from "./jobs/job-runner.js";
import { createMcpServer } from "./mcp-server.js";
import type { SkillsContext } from "./skills/skill-catalog.js";

export interface McpDeps {
  /** The caller's job context for the CLI runner tools (absent = tools not offered). */
  jobs?: JobToolsContext;
  /** The caller's MCP Events context (absent = events not offered). */
  events?: EventsContext;
  /** The caller's skills context (absent = built-in skills only). */
  skills?: SkillsContext;
}

/**
 * Modern-era methods this stateless deployment does not serve. A
 * `subscriptions/listen` stream would hold a Worker request open for change
 * notifications that never come: the tool list is fixed per deployment.
 */
const UNSERVED_METHODS = new Set(["subscriptions/listen"]);

function rpcMethod(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const method = (body as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}

function rpcId(body: unknown): string | number | null {
  const id = body !== null && typeof body === "object" ? (body as { id?: unknown }).id : null;
  return typeof id === "string" || typeof id === "number" ? id : null;
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

  if (!(await isLegacyRequest(request, parsedBody, { maxRequestBodySize: MAX_BODY_BYTES }))) {
    return withHeaders(await handleModern(request, env, deps, parsedBody), {
      ...SECURITY_HEADERS,
      ...cors,
    });
  }

  const server = createMcpServer(env, {
    version,
    jobs: deps.jobs,
    skills: deps.skills,
    era: "legacy",
  });
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

/** One 2026-07-28 exchange through the SDK's modern (envelope) handler. */
async function handleModern(
  request: Request,
  env: Env,
  deps: McpDeps,
  parsedBody: unknown,
): Promise<Response> {
  // The SDK leaves the media-type check to hand-wired compositions.
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return jsonRpcError(415, -32000, "Content-Type must be application/json");
  }
  const method = rpcMethod(parsedBody);
  if (method !== undefined && UNSERVED_METHODS.has(method)) {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: rpcId(parsedBody),
        error: { code: -32601, message: "Method not found" },
      },
      // Status the SDK's modern handler gives its own Method not found answers.
      { status: 404 },
    );
  }
  const handler = createMcpHandler(
    () =>
      createMcpServer(env, {
        version,
        jobs: deps.jobs,
        events: deps.events,
        skills: deps.skills,
        era: "modern",
      }),
    { legacy: "reject", responseMode: "json", maxRequestBodySize: MAX_BODY_BYTES },
  );
  try {
    return await handler.fetch(request, { parsedBody });
  } finally {
    await handler.close();
  }
}
