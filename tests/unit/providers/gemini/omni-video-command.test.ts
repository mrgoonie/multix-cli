import { describe, expect, it } from "vitest";
import { buildOmniVideoMetadata } from "../../../../src/providers/gemini/commands/omni-video.js";

describe("Gemini Omni video command", () => {
  it("writes metadata without exposing absolute input paths", () => {
    expect(
      buildOmniVideoMetadata(
        {
          prompt: "Turn this into a cinematic product shot",
          image: ["/private/source/product.png"],
          video: undefined,
        },
        "interaction-123",
      ),
    ).toMatchObject({
      provider: "gemini",
      model: "gemini-omni-flash-preview",
      prompt: "Turn this into a cinematic product shot",
      inputFiles: ["product.png"],
      interactionId: "interaction-123",
    });
  });
});
