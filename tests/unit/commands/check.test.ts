import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for check command helpers.
 * Uses vi.stubGlobal to intercept globalThis.fetch before module functions run.
 */

describe("gemini-ping helper", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns success when API responds with models array", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ models: [{ name: "m1" }, { name: "m2" }] }), { status: 200 }),
    );
    const { pingGemini } = await import("../../../src/commands/check-helpers/gemini-ping.js");
    const result = await pingGemini("fake-key");
    expect(result.status).toBe("success");
    expect(result.modelCount).toBe(2);
  });

  it("returns auth_error on 401", async () => {
    vi.stubGlobal("fetch", async () => new Response("Unauthorized", { status: 401 }));
    const { pingGemini } = await import("../../../src/commands/check-helpers/gemini-ping.js");
    const result = await pingGemini("bad-key");
    expect(result.status).toBe("auth_error");
  });

  it("returns auth_error on 403", async () => {
    vi.stubGlobal("fetch", async () => new Response("Forbidden", { status: 403 }));
    const { pingGemini } = await import("../../../src/commands/check-helpers/gemini-ping.js");
    const result = await pingGemini("bad-key");
    expect(result.status).toBe("auth_error");
  });

  it("returns network_error when fetch throws", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("Connection refused");
    });
    const { pingGemini } = await import("../../../src/commands/check-helpers/gemini-ping.js");
    const result = await pingGemini("any-key");
    expect(result.status).toBe("network_error");
  });
});

describe("binary-check helper", () => {
  it("returns available:true for a real binary (node)", async () => {
    // node is always available in test environment
    const { checkBinary } = await import("../../../src/commands/check-helpers/binary-check.js");
    const result = await checkBinary("node");
    expect(result.available).toBe(true);
  });

  it("returns available:false for nonexistent binary", async () => {
    const { checkBinary } = await import("../../../src/commands/check-helpers/binary-check.js");
    // Use a name that is definitely not a real binary and has no exitCode
    const result = await checkBinary("zzz_multix_fake_binary_xyz");
    expect(result.available).toBe(false);
  });
});
