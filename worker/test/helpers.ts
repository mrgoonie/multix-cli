import type { Env } from "../src/config.js";
import { type HandlerDeps, handleRequest } from "../src/index.js";

export const TOKEN = "test-token-0123456789abcdef0123456789abcdef";
export const REPLICATE_KEY = "r8_replicate_secret_value_123456";
export const ATLAS_KEY = "atlas_secret_value_123456789";
export const HEYGEN_KEY = "heygen_secret_value_123456789";
export const CF_TOKEN = "cf_secret_value_1234567890";

export function fullEnv(overrides: Partial<Env> = {}): Env {
  return {
    MCP_AUTH_TOKEN: TOKEN,
    REPLICATE_API_TOKEN: REPLICATE_KEY,
    ATLASCLOUD_API_KEY: ATLAS_KEY,
    HEYGEN_API_KEY: HEYGEN_KEY,
    CLOUDFLARE_ACCOUNT_ID: "acct123",
    CLOUDFLARE_API_TOKEN: CF_TOKEN,
    CLOUDFLARE_AI_GATEWAY_ID: "gw1",
    ...overrides,
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Route = (call: RecordedCall) => Response | undefined;

/** Fake provider fetch: the first route returning a Response wins; unmatched calls fail loudly. */
export function mockFetch(...routes: Route[]) {
  const calls: RecordedCall[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const call: RecordedCall = {
      url: input,
      method: init?.method ?? "GET",
      headers,
      body: raw ? JSON.parse(raw) : undefined,
    };
    calls.push(call);
    for (const route of routes) {
      const response = route(call);
      if (response) return response;
    }
    throw new Error(`Unexpected provider request: ${call.method} ${call.url}`);
  };
  return { fetch, calls };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function route(
  method: string,
  pattern: RegExp,
  respond: (call: RecordedCall) => Response,
): Route {
  return (call) => (call.method === method && pattern.test(call.url) ? respond(call) : undefined);
}

let nextId = 1;

export function mcpRequest(
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Request {
  return new Request("https://mcp.example.com/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
}

// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC payloads are untyped in tests
type Json = any;

export async function rpc(
  env: Env,
  method: string,
  params = {},
  deps: HandlerDeps = {},
): Promise<Json> {
  const response = await handleRequest(mcpRequest(method, params), env, deps);
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

/** tools/call and return the tool result (`result` of the JSON-RPC response). */
export async function callTool(
  env: Env,
  name: string,
  args: Record<string, unknown>,
  deps: HandlerDeps = {},
): Promise<Json> {
  const body = await rpc(env, "tools/call", { name, arguments: args }, deps);
  if (body.error) throw new Error(`JSON-RPC error: ${JSON.stringify(body.error)}`);
  return body.result;
}
