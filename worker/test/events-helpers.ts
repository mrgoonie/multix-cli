/**
 * Helpers for MCP Events tests: fake DNS-over-HTTPS answers, a callback
 * receiver that answers verification challenges, and 2026-07-28 requests
 * (per-request `_meta` envelope plus the matching HTTP headers).
 */

import type { Env } from "../src/config.js";
import { type McpDeps, handleMcpRequest } from "../src/mcp-api-handler.js";
import { type RecordedCall, jsonResponse, route } from "./helpers.js";

export const MODERN_VERSION = "2026-07-28";
export const SECRET = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;

/** DNS-over-HTTPS answers for `host` (other names are NXDOMAIN). */
export function dohRoute(host: string, a: string[], aaaa: string[] = [], status = 0) {
  return route("GET", /^https:\/\/cloudflare-dns\.com\/dns-query\?/, (call) => {
    const url = new URL(call.url);
    if (url.searchParams.get("name") !== host) return jsonResponse({ Status: 3 });
    const type = url.searchParams.get("type");
    const records = type === "A" ? a : aaaa;
    return jsonResponse({
      Status: status,
      Answer: records.map((data) => ({ type: type === "A" ? 1 : 28, data })),
    });
  });
}

/** A callback at https://`host``path` that echoes verification challenges. */
export function callbackRoute(host: string, path = "/cb", status = 200) {
  const pattern = new RegExp(`^https://${host.replace(/\./g, "\\.")}${path}$`);
  return route("POST", pattern, (call: RecordedCall) =>
    jsonResponse({ challenge: (call.body as { challenge?: string }).challenge }, status),
  );
}

let nextId = 1;

export function modernRequest(
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Request {
  const target =
    method === "tools/call" ? params.name : method === "resources/read" ? params.uri : undefined;
  const name: Record<string, string> = typeof target === "string" ? { "mcp-name": target } : {};
  return new Request("https://mcp.example.com/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": MODERN_VERSION,
      "mcp-method": method,
      ...name,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
        },
      },
    }),
  });
}

// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC payloads are untyped in tests
type Json = any;

export async function modernRpc(
  env: Env,
  method: string,
  params: Record<string, unknown> = {},
  deps: McpDeps = {},
): Promise<Json> {
  // Modern responses map some JSON-RPC errors onto HTTP statuses (Method not found = 404).
  const response = await handleMcpRequest(modernRequest(method, params), env, deps);
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}
