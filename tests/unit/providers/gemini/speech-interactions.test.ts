import { beforeEach, describe, expect, it, vi } from "vitest";

const createInteraction = vi.fn();
vi.mock("../../../../src/providers/gemini/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/providers/gemini/client.js")>()),
  createInteraction: (body: Record<string, unknown>) => createInteraction(body),
}));

const { generateGeminiSpeech } = await import(
  "../../../../src/providers/gemini/generators/speech.js"
);

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), debug: vi.fn() };
}

describe("generateGeminiSpeech via the Interactions API", () => {
  beforeEach(() => createInteraction.mockReset());

  it("reports a non-completed interaction status instead of a generic no-audio error", async () => {
    createInteraction.mockResolvedValue({ status: "failed", error: { message: "quota exceeded" } });
    const result = await generateGeminiSpeech({
      text: "Hello",
      model: "gemini-3.8-flash-lite-tts",
      outputFormat: "wav",
    });
    expect(result).toEqual({ status: "error", error: "Interaction failed: quota exceeded" });
  });

  it("warns when an inline delivery direction would be read aloud verbatim", async () => {
    createInteraction.mockResolvedValue({ status: "failed" });
    const logger = makeLogger();
    await generateGeminiSpeech({
      text: "Say cheerfully: Have a wonderful day!",
      model: "gemini-3.8-flash-lite-tts",
      outputFormat: "wav",
      logger: logger as never,
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("--style"));
  });

  it("does not warn when a style is supplied", async () => {
    createInteraction.mockResolvedValue({ status: "failed" });
    const logger = makeLogger();
    await generateGeminiSpeech({
      text: "Say cheerfully: Have a wonderful day!",
      model: "gemini-3.8-flash-lite-tts",
      style: "cheerful",
      outputFormat: "wav",
      logger: logger as never,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
