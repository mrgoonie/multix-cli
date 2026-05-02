import { describe, it, expect } from "vitest";
import {
  isMinimaxModel,
  MINIMAX_IMAGE_MODELS,
  MINIMAX_VIDEO_MODELS,
  MINIMAX_SPEECH_MODELS,
  MINIMAX_MUSIC_MODELS,
  TASK_DEFAULTS,
} from "../../../../src/providers/minimax/models.js";

describe("MiniMax model sets", () => {
  it("image models contains image-01", () => {
    expect(MINIMAX_IMAGE_MODELS.has("image-01")).toBe(true);
  });

  it("video models contains MiniMax-Hailuo-2.3", () => {
    expect(MINIMAX_VIDEO_MODELS.has("MiniMax-Hailuo-2.3")).toBe(true);
  });

  it("speech models contains speech-2.8-hd", () => {
    expect(MINIMAX_SPEECH_MODELS.has("speech-2.8-hd")).toBe(true);
  });

  it("music models contains music-2.5", () => {
    expect(MINIMAX_MUSIC_MODELS.has("music-2.5")).toBe(true);
  });
});

describe("TASK_DEFAULTS", () => {
  it("image default is image-01", () => {
    expect(TASK_DEFAULTS.image).toBe("image-01");
  });

  it("video default is MiniMax-Hailuo-2.3", () => {
    expect(TASK_DEFAULTS.video).toBe("MiniMax-Hailuo-2.3");
  });

  it("speech default is speech-2.8-hd", () => {
    expect(TASK_DEFAULTS.speech).toBe("speech-2.8-hd");
  });

  it("music default is music-2.5", () => {
    expect(TASK_DEFAULTS.music).toBe("music-2.5");
  });
});

describe("isMinimaxModel", () => {
  it("returns true for image-01", () => {
    expect(isMinimaxModel("image-01")).toBe(true);
  });

  it("returns true for MiniMax-Hailuo-2.3", () => {
    expect(isMinimaxModel("MiniMax-Hailuo-2.3")).toBe(true);
  });

  it("returns true for speech-2.8-hd", () => {
    expect(isMinimaxModel("speech-2.8-hd")).toBe(true);
  });

  it("returns true for music-2.5", () => {
    expect(isMinimaxModel("music-2.5")).toBe(true);
  });

  it("returns false for gemini model", () => {
    expect(isMinimaxModel("gemini-2.5-flash")).toBe(false);
  });

  it("returns false for openrouter model", () => {
    expect(isMinimaxModel("google/gemini-flash")).toBe(false);
  });
});
