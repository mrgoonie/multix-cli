import { afterEach, describe, expect, it, vi } from "vitest";

describe("fetchRegistryVersion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the version from a successful registry response", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      expect(String(url)).toBe("https://registry.npmjs.org/@mrgoonie/multix/latest");
      return new Response(JSON.stringify({ version: "1.2.3" }), { status: 200 });
    });
    const { fetchRegistryVersion } = await import("../../../src/commands/update.js");
    await expect(fetchRegistryVersion()).resolves.toBe("1.2.3");
  });

  it("requests the given dist-tag", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      expect(String(url)).toBe("https://registry.npmjs.org/@mrgoonie/multix/beta");
      return new Response(JSON.stringify({ version: "1.3.0-beta.1" }), { status: 200 });
    });
    const { fetchRegistryVersion } = await import("../../../src/commands/update.js");
    await expect(fetchRegistryVersion("beta")).resolves.toBe("1.3.0-beta.1");
  });

  it("throws a clear error for an unknown dist-tag (404)", async () => {
    vi.stubGlobal("fetch", async () => new Response("Not Found", { status: 404 }));
    const { fetchRegistryVersion } = await import("../../../src/commands/update.js");
    await expect(fetchRegistryVersion("nonexistent")).rejects.toThrow(/does not exist/);
  });

  it("throws a clear error on network failure", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ENOTFOUND registry.npmjs.org");
    });
    const { fetchRegistryVersion } = await import("../../../src/commands/update.js");
    await expect(fetchRegistryVersion()).rejects.toThrow(/Failed to reach npm registry/);
  });
});

describe("getCurrentVersion", () => {
  it("returns a non-empty semver-ish string from package.json", async () => {
    const { getCurrentVersion } = await import("../../../src/commands/update.js");
    expect(getCurrentVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
