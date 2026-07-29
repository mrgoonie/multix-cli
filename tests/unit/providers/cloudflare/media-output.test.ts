import { describe, expect, it } from "vitest";
import { ProviderError } from "../../../../src/core/errors.js";
import { isTerminalVideoStatus } from "../../../../src/providers/cloudflare/commands/video-helpers.js";
import { saveBase64Image } from "../../../../src/providers/cloudflare/media-output.js";

describe("Cloudflare media output safety", () => {
  it("rejects malformed image base64 before writing a file", () => {
    expect(() => saveBase64Image("not-valid-base64?", "./tmp.jpg")).toThrow(ProviderError);
  });

  it("treats canceled predictions as terminal", () => {
    expect(isTerminalVideoStatus("succeeded")).toBe(true);
    expect(isTerminalVideoStatus("failed")).toBe(true);
    expect(isTerminalVideoStatus("canceled")).toBe(true);
    expect(isTerminalVideoStatus("cancelled")).toBe(true);
    expect(isTerminalVideoStatus("aborted")).toBe(true);
    expect(isTerminalVideoStatus("processing")).toBe(false);
  });
});
