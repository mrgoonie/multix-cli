import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "../src/config.js";
import { handleMcpRequest } from "../src/mcp-api-handler.js";
import { fullEnv, mcpRequest } from "./helpers.js";

// Authentication, discovery and rate limiting are covered in oauth-flow.test.ts;
// these tests exercise /mcp after a token has been accepted.

function post(body: string): Request {
  return new Request("https://mcp.example.com/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body,
  });
}

describe("/mcp browser origins", () => {
  it("rejects disallowed browser origins and accepts listed ones", async () => {
    const env = fullEnv({ MULTIX_MCP_ALLOWED_ORIGINS: "https://app.example.com" });
    const evil = await handleMcpRequest(
      mcpRequest("tools/list", {}, { origin: "https://evil.example" }),
      env,
    );
    expect(evil.status).toBe(403);
    const good = await handleMcpRequest(
      mcpRequest("tools/list", {}, { origin: "https://app.example.com" }),
      env,
    );
    expect(good.status).toBe(200);
    expect(good.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(good.headers.get("cache-control")).toBe("no-store");
  });

  it("adds no CORS headers for non-browser callers", async () => {
    const response = await handleMcpRequest(mcpRequest("tools/list"), fullEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("/mcp request handling", () => {
  it("returns 405 for GET (stateless server has no SSE stream)", async () => {
    const request = new Request("https://mcp.example.com/mcp", {
      headers: { accept: "text/event-stream" },
    });
    expect((await handleMcpRequest(request, fullEnv())).status).toBe(405);
  });

  it("rejects oversized bodies with 413", async () => {
    const response = await handleMcpRequest(
      post(JSON.stringify({ padding: "x".repeat(MAX_BODY_BYTES) })),
      fullEnv(),
    );
    expect(response.status).toBe(413);
  });

  it("returns a JSON-RPC parse error for malformed JSON", async () => {
    const response = await handleMcpRequest(post("{not json"), fullEnv());
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("rejects JSON-RPC batches before they reach the MCP transport", async () => {
    const call = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "multix_list_providers", arguments: {} },
    });
    const response = await handleMcpRequest(post(JSON.stringify([call(1), call(2)])), fullEnv());
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number; message: string } };
    expect(body.error).toEqual({ code: -32600, message: "Batch requests are not supported" });
  });
});
