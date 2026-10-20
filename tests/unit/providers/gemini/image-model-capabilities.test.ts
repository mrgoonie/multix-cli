import { describe, expect, it } from "vitest";
import { buildImageGenerationConfig } from "../../../../src/providers/gemini/commands/generate.js";
import { buildImageToImageGenerationConfig } from "../../../../src/providers/gemini/commands/image-to-image.js";
import { IMAGE_MODEL_LITE, resolveImageOptions } from "../../../../src/providers/gemini/models.js";

describe("Nano Banana 2 Lite capabilities", () => {
  it("is registered and always requests 1K output", () => {
    expect(resolveImageOptions(IMAGE_MODEL_LITE, "16:9")).toEqual({
      aspectRatio: "16:9",
      imageSize: "1K",
    });
    expect(buildImageGenerationConfig(IMAGE_MODEL_LITE, "1:1")).toEqual({
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "1:1", imageSize: "1K" },
    });
    expect(buildImageToImageGenerationConfig(IMAGE_MODEL_LITE, "21:9", "1K")).toEqual({
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "21:9", imageSize: "1K" },
    });
  });

  it("rejects unsupported Lite output sizes", () => {
    expect(() => resolveImageOptions(IMAGE_MODEL_LITE, "1:1", "2K")).toThrow("supports only 1K");
  });
});
