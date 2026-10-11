import { afterEach, describe, expect, it, vi } from "vitest";
import { pingGemini } from "../../../src/commands/check-helpers/gemini-ping.js";

describe("pingGemini", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the key as a header, never in the URL", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenHeaders = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ models: [{}, {}] }), { status: 200 });
    });
    const res = await pingGemini("AIzaTESTKEY1234567890");
    expect(res).toEqual({ status: "success", modelCount: 2 });
    expect(seenUrl).not.toContain("AIzaTESTKEY");
    expect(seenHeaders["x-goog-api-key"]).toBe("AIzaTESTKEY1234567890");
  });

  it("classifies 403 as an auth error", async () => {
    vi.stubGlobal("fetch", async () => new Response("denied", { status: 403 }));
    const res = await pingGemini("AIzaTESTKEY1234567890");
    expect(res.status).toBe("auth_error");
  });
});
