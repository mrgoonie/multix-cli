import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("passes a custom version flag through to the binary", async () => {
    const { checkBinary } = await import("../../../src/commands/check-helpers/binary-check.js");
    const result = await checkBinary("node", "-v");
    expect(result.available).toBe(true);
    expect(result.version).toMatch(/^v\d+\./);
  });

  it.skipIf(process.platform === "win32")(
    "detects a binary that rejects --version with 'not found' in stderr",
    async () => {
      // Regression: ffmpeg 8.x exits non-zero on `--version` with
      // "Error splitting the argument list: Option not found". The stderr
      // substring test used to read that as a missing binary.
      const { checkBinary } = await import("../../../src/commands/check-helpers/binary-check.js");
      const dir = await mkdtemp(join(tmpdir(), "multix-binary-check-"));
      const fake = join(dir, "fake-ffmpeg");
      await writeFile(
        fake,
        [
          "#!/bin/sh",
          'if [ "$1" = "-version" ]; then',
          '  echo "fake-ffmpeg version 8.1.2"',
          "  exit 0",
          "fi",
          'echo "Error splitting the argument list: Option not found" >&2',
          "exit 8",
        ].join("\n"),
        { mode: 0o755 },
      );

      try {
        const withDefaultFlag = await checkBinary(fake);
        expect(withDefaultFlag.available).toBe(false); // the old, wrong answer

        const withCorrectFlag = await checkBinary(fake, "-version");
        expect(withCorrectFlag.available).toBe(true);
        expect(withCorrectFlag.version).toBe("fake-ffmpeg version 8.1.2");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("check command provider readiness", () => {
  // Restore env even when an assertion fails mid-test.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("includes OpenAI in provider diagnostics", async () => {
    const { getCheckProviders } = await import("../../../src/commands/check.js");
    expect(getCheckProviders()).toContainEqual(
      expect.objectContaining({
        name: "OpenAI",
        envPrimary: "OPENAI_API_KEY",
      }),
    );
  });

  it("counts authenticated Codex as experimental image readiness only when no provider key exists", async () => {
    const { checkCodexImageReadiness } = await import("../../../src/commands/check.js");
    const checker = vi.fn(async () => true);

    await expect(checkCodexImageReadiness(false, false, checker)).resolves.toBe(true);
    await expect(checkCodexImageReadiness(true, false, checker)).resolves.toBe(false);
    expect(checker).toHaveBeenCalledTimes(1);
  });

  it("checks authenticated Codex in verbose mode even when provider keys exist", async () => {
    const { checkCodexImageReadiness } = await import("../../../src/commands/check.js");
    const checker = vi.fn(async () => true);

    await expect(checkCodexImageReadiness(true, true, checker)).resolves.toBe(true);
    expect(checker).toHaveBeenCalledTimes(1);
  });

  it("reports Cloudflare native and video readiness separately", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    const { cloudflareReadiness } = await import("../../../src/commands/check.js");
    expect(cloudflareReadiness()).toMatchObject({ native: true, video: false });

    vi.stubEnv("CLOUDFLARE_AI_GATEWAY_ID", "gateway");
    vi.stubEnv("REPLICATE_API_TOKEN", "replicate");
    expect(cloudflareReadiness()).toMatchObject({ native: true, video: true });
  });

  it("reports direct Replicate readiness separately from Cloudflare AI Gateway video", async () => {
    const { getCheckProviders, cloudflareReadiness } = await import(
      "../../../src/commands/check.js"
    );
    expect(getCheckProviders()).toContainEqual(
      expect.objectContaining({
        name: "Replicate",
        envPrimary: "REPLICATE_API_TOKEN",
        envFallback: "REPLICATE_API_KEY",
        optional: true,
      }),
    );
    // A Replicate token alone does not make Cloudflare video ready.
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    vi.stubEnv("REPLICATE_API_TOKEN", "replicate");
    expect(cloudflareReadiness()).toMatchObject({ native: false, video: false });
  });

  it("resolves Replicate tokens like the provider: trimmed, then fallback", async () => {
    const { getCheckProviders, resolveProviderKey } = await import(
      "../../../src/commands/check.js"
    );
    const replicate = getCheckProviders().find((p) => p.name === "Replicate");
    if (!replicate) throw new Error("Replicate provider entry missing");
    vi.stubEnv("REPLICATE_API_TOKEN", "   ");
    vi.stubEnv("REPLICATE_API_KEY", " key-value ");
    expect(resolveProviderKey(replicate)).toEqual({
      key: "key-value",
      envUsed: "REPLICATE_API_KEY",
    });
    vi.stubEnv("REPLICATE_API_KEY", "");
    expect(resolveProviderKey(replicate)).toEqual({});
  });

  it("does not let REPLICATE_API_KEY alone make Cloudflare video ready", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    vi.stubEnv("CLOUDFLARE_AI_GATEWAY_ID", "gateway");
    vi.stubEnv("REPLICATE_API_TOKEN", "");
    vi.stubEnv("REPLICATE_API_KEY", "replicate-key");
    const { cloudflareReadiness } = await import("../../../src/commands/check.js");
    expect(cloudflareReadiness()).toMatchObject({ native: true, video: false });
  });

  it("does not count whitespace-only Cloudflare credentials as configured", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "   ");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "\t");
    const { cloudflareReadiness } = await import("../../../src/commands/check.js");
    expect(cloudflareReadiness()).toMatchObject({ native: false, video: false });
  });
});

describe("check command provider readiness", () => {
  it("includes OpenAI in provider diagnostics", async () => {
    const { getCheckProviders } = await import("../../../src/commands/check.js");
    expect(getCheckProviders()).toContainEqual(
      expect.objectContaining({
        name: "OpenAI",
        envPrimary: "OPENAI_API_KEY",
      }),
    );
  });

  it("counts authenticated Codex as experimental image readiness only when no provider key exists", async () => {
    const { checkCodexImageReadiness } = await import("../../../src/commands/check.js");
    const checker = vi.fn(async () => true);

    await expect(checkCodexImageReadiness(false, false, checker)).resolves.toBe(true);
    await expect(checkCodexImageReadiness(true, false, checker)).resolves.toBe(false);
    expect(checker).toHaveBeenCalledTimes(1);
  });

  it("checks authenticated Codex in verbose mode even when provider keys exist", async () => {
    const { checkCodexImageReadiness } = await import("../../../src/commands/check.js");
    const checker = vi.fn(async () => true);

    await expect(checkCodexImageReadiness(true, true, checker)).resolves.toBe(true);
    expect(checker).toHaveBeenCalledTimes(1);
  });
});
