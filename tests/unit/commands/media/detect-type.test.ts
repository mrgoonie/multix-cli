import { describe, expect, it } from "vitest";
import { extToKind } from "../../../../src/commands/media/detect-type.js";

describe("extToKind", () => {
  // Video
  it("identifies .mp4 as video", () => expect(extToKind(".mp4")).toBe("video"));
  it("identifies .mov as video", () => expect(extToKind(".mov")).toBe("video"));
  it("identifies .avi as video", () => expect(extToKind(".avi")).toBe("video"));
  it("identifies .mkv as video", () => expect(extToKind(".mkv")).toBe("video"));
  it("identifies .webm as video", () => expect(extToKind(".webm")).toBe("video"));

  // Audio
  it("identifies .mp3 as audio", () => expect(extToKind(".mp3")).toBe("audio"));
  it("identifies .wav as audio", () => expect(extToKind(".wav")).toBe("audio"));
  it("identifies .flac as audio", () => expect(extToKind(".flac")).toBe("audio"));
  it("identifies .aac as audio", () => expect(extToKind(".aac")).toBe("audio"));
  it("identifies .m4a as audio", () => expect(extToKind(".m4a")).toBe("audio"));

  // Image
  it("identifies .jpg as image", () => expect(extToKind(".jpg")).toBe("image"));
  it("identifies .jpeg as image", () => expect(extToKind(".jpeg")).toBe("image"));
  it("identifies .png as image", () => expect(extToKind(".png")).toBe("image"));
  it("identifies .webp as image", () => expect(extToKind(".webp")).toBe("image"));

  // Uppercase extension
  it("handles uppercase extensions", () => expect(extToKind(".MP4")).toBe("video"));
  it("handles mixed case", () => expect(extToKind(".JPG")).toBe("image"));

  // Unknown
  it("returns undefined for .pdf", () => expect(extToKind(".pdf")).toBeUndefined());
  it("returns undefined for .txt", () => expect(extToKind(".txt")).toBeUndefined());
  it("returns undefined for unknown ext", () => expect(extToKind(".xyz")).toBeUndefined());
});
