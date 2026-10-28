import { describe, expect, it } from "vitest";
import { fullEnv, rpc } from "./helpers.js";

describe("MCP protocol", () => {
  it("initializes over Streamable HTTP", async () => {
    const body = await rpc(fullEnv(), "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(body.result.serverInfo.name).toBe("multix");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("offers only the catalog tools when the job bindings are absent", async () => {
    const body = await rpc(fullEnv(), "tools/list");
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["multix_catalog", "multix_model_catalog"]);
  });

  it("reports an unknown tool as an error", async () => {
    const body = await rpc(fullEnv(), "tools/call", { name: "multix_nope", arguments: {} });
    expect(body.error ?? body.result?.isError).toBeTruthy();
  });
});
