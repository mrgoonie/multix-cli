import { describe, expect, it, vi } from "vitest";
import { version } from "../../package.json";
import { MAX_BODY_BYTES } from "../src/config.js";
import { handleRequest } from "../src/index.js";
import { TOKEN, fullEnv, mcpRequest } from "./helpers.js";

describe("/health", () => {
  it("is public and returns only ok + version", async () => {
    const response = await handleRequest(new Request("https://mcp.example.com/health"), {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version });
  });

  it("rejects other methods", async () => {
    const response = await handleRequest(
      new Request("https://mcp.example.com/health", { method: "POST" }),
      {},
    );
    expect(response.status).toBe(405);
  });
});

describe("/mcp authentication", () => {
  it("fails closed with 503 when MCP_AUTH_TOKEN is unset", async () => {
    const response = await handleRequest(mcpRequest("tools/list"), fullEnv({ MCP_AUTH_TOKEN: "" }));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Service Unavailable");
  });

  it("fails closed when MCP_AUTH_TOKEN is too short to be safe", async () => {
    const env = fullEnv({ MCP_AUTH_TOKEN: "short" });
    const response = await handleRequest(
      mcpRequest("tools/list", {}, { authorization: "Bearer short" }),
      env,
    );
    expect(response.status).toBe(503);
  });

  it("returns 401 without detail when the token is missing", async () => {
    const response = await handleRequest(
      mcpRequest("tools/list", {}, { authorization: "" }),
      fullEnv(),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(await response.text()).toBe("Unauthorized");
  });

  it("returns 401 for a wrong token, including a prefix of the right one", async () => {
    for (const bad of ["Bearer wrong", `Bearer ${TOKEN.slice(0, -1)}`, `Basic ${TOKEN}`, TOKEN]) {
      const response = await handleRequest(
        mcpRequest("tools/list", {}, { authorization: bad }),
        fullEnv(),
      );
      expect(response.status).toBe(401);
    }
  });

  it("rejects disallowed browser origins and accepts listed ones", async () => {
    const env = fullEnv({ MULTIX_MCP_ALLOWED_ORIGINS: "https://app.example.com" });
    const evil = await handleRequest(
      mcpRequest("tools/list", {}, { origin: "https://evil.example" }),
      env,
    );
    expect(evil.status).toBe(403);
    const good = await handleRequest(
      mcpRequest("tools/list", {}, { origin: "https://app.example.com" }),
      env,
    );
    expect(good.status).toBe(200);
  });

  it("applies the optional rate limiter before authentication", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const response = await handleRequest(
      mcpRequest("tools/list"),
      fullEnv({ MCP_RATE_LIMITER: { limit } }),
    );
    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledOnce();
  });
});

describe("/mcp request handling", () => {
  it("returns 405 for GET (stateless server has no SSE stream)", async () => {
    const request = new Request("https://mcp.example.com/mcp", {
      headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
    });
    expect((await handleRequest(request, fullEnv())).status).toBe(405);
  });

  it("rejects oversized bodies with 413", async () => {
    const request = new Request("https://mcp.example.com/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ padding: "x".repeat(MAX_BODY_BYTES) }),
    });
    expect((await handleRequest(request, fullEnv())).status).toBe(413);
  });

  it("returns a JSON-RPC parse error for malformed JSON", async () => {
    const request = new Request("https://mcp.example.com/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: "{not json",
    });
    const response = await handleRequest(request, fullEnv());
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("returns 404 for unknown paths", async () => {
    const response = await handleRequest(new Request("https://mcp.example.com/"), fullEnv());
    expect(response.status).toBe(404);
  });
});
