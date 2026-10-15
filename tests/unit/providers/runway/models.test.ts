import { describe, expect, it } from "vitest";
import {
  PROMPT_MAX_LENGTH,
  assertTaskId,
  formatCredits,
  getImageModel,
  getVideoModel,
  isTerminalStatus,
  validateDuration,
  validateImageRatio,
  validatePromptText,
  validatePublicFigureThreshold,
  validateReferenceTag,
  validateSeed,
  validateVideoRatio,
} from "../../../../src/providers/runway/models.js";
import { outputFilename, summarizeTask } from "../../../../src/providers/runway/output.js";

describe("runway model registry", () => {
  it("resolves known models and rejects unknown ones with the supported list", () => {
    expect(getVideoModel("gen4.5").textToVideo).toBe(true);
    expect(getVideoModel("gen4_turbo").textToVideo).toBe(false);
    expect(getImageModel("gen4_image_turbo").minReferences).toBe(1);
    expect(() => getVideoModel("gen3a_turbo")).toThrow(/Supported: gen4.5, gen4_turbo/);
    expect(() => getImageModel("dall-e")).toThrow(/gen4_image, gen4_image_turbo/);
  });

  it("validates durations as integers within the model range", () => {
    const m = getVideoModel("gen4.5");
    expect(validateDuration(m, "2")).toBe(2);
    expect(validateDuration(m, "10")).toBe(10);
    for (const bad of ["1", "11", "5.5", "", "five"]) {
      expect(() => validateDuration(m, bad)).toThrow(/2 to 10/);
    }
  });

  it("allows only text-to-video ratios without an image", () => {
    const m = getVideoModel("gen4.5");
    expect(validateVideoRatio(m, "720:1280", false)).toBe("720:1280");
    expect(() => validateVideoRatio(m, "960:960", false)).toThrow(/text-to-video/);
    expect(validateVideoRatio(m, "960:960", true)).toBe("960:960");
    expect(() => validateVideoRatio(m, "16:9", true)).toThrow(/Use one of/);
  });

  it("validates image ratios", () => {
    const m = getImageModel("gen4_image");
    expect(validateImageRatio(m, "1920:1080")).toBe("1920:1080");
    expect(() => validateImageRatio(m, "4096:4096")).toThrow(/not supported/);
  });

  it("validates prompts, seeds, tags and moderation levels", () => {
    expect(validatePromptText("  hi  ", true)).toBe("hi");
    expect(validatePromptText("", false)).toBeUndefined();
    expect(() => validatePromptText(" ", true)).toThrow(/empty/);
    expect(() => validatePromptText("x".repeat(PROMPT_MAX_LENGTH + 1), true)).toThrow(
      /at most 1000/,
    );
    expect(validateSeed("4294967295")).toBe(4294967295);
    expect(() => validateSeed("4294967296")).toThrow(/0 to/);
    expect(() => validateSeed("-1")).toThrow();
    expect(validateReferenceTag("hero_1")).toBe("hero_1");
    for (const bad of ["ab", "1abc", "a-b-c", "x".repeat(17)]) {
      expect(() => validateReferenceTag(bad)).toThrow(/Invalid reference tag/);
    }
    expect(validatePublicFigureThreshold("low")).toBe("low");
    expect(() => validatePublicFigureThreshold("off")).toThrow(/auto, low/);
  });

  it("accepts only path-safe task ids", () => {
    expect(assertTaskId(" abc-123 ")).toBe("abc-123");
    for (const bad of ["../x", "a/b", "", "-abc", "a b", "id?x=1"]) {
      expect(() => assertTaskId(bad)).toThrow(/Invalid Runway task id/);
    }
  });

  it("classifies terminal statuses and formats credits", () => {
    expect(isTerminalStatus("SUCCEEDED")).toBe(true);
    expect(isTerminalStatus("CANCELLED")).toBe(true);
    expect(isTerminalStatus("THROTTLED")).toBe(false);
    expect(formatCredits(60)).toBe("60 credits (≈ $0.60)");
  });
});

describe("runway output helpers", () => {
  it("redacts signed output URLs in summaries", () => {
    const summary = summarizeTask({
      id: "abc",
      status: "SUCCEEDED",
      cost: { credits: 25 },
      output: ["https://cdn.example/out.mp4?X-Amz-Signature=SECRET"],
    });
    expect(JSON.stringify(summary)).not.toContain("SECRET");
    expect(summary.credits).toBe(25);
  });

  it("builds file names that cannot add path segments", () => {
    expect(outputFilename("17f20503-6c24", 0, ".mp4")).toBe("runway-17f20503-01.mp4");
    expect(outputFilename("../..", 1, ".png")).toBe("runway-output-02.png");
  });
});
