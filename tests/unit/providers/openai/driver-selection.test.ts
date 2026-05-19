import { describe, expect, it } from "vitest";
import { resolveImageDriver } from "../../../../src/providers/openai/codex-image-driver.js";

describe("OpenAI image driver selection", () => {
  it("uses API when requested and key exists", async () => {
    await expect(resolveImageDriver({ requested: "api", hasApiKey: true })).resolves.toBe("api");
  });

  it("rejects API when requested without key", async () => {
    await expect(resolveImageDriver({ requested: "api", hasApiKey: false })).rejects.toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it("prefers API in auto mode when key exists", async () => {
    await expect(
      resolveImageDriver({
        requested: "auto",
        hasApiKey: true,
        codexAuthCheck: async () => true,
      }),
    ).resolves.toBe("api");
  });

  it("falls back to Codex in auto mode when authenticated", async () => {
    await expect(
      resolveImageDriver({
        requested: "auto",
        hasApiKey: false,
        codexAuthCheck: async () => true,
      }),
    ).resolves.toBe("codex");
  });

  it("errors when no driver is available", async () => {
    await expect(
      resolveImageDriver({
        requested: "auto",
        hasApiKey: false,
        codexAuthCheck: async () => false,
      }),
    ).rejects.toThrow(/OPENAI_API_KEY|codex login/);
  });
});
