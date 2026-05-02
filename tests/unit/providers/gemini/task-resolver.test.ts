import { describe, it, expect } from "vitest";
import { inferTaskFromFile, getMimeType, requiresProcessingWait } from "../../../../src/providers/gemini/task-resolver.js";

describe("inferTaskFromFile", () => {
  it("returns transcribe for .mp3", () => {
    expect(inferTaskFromFile("audio.mp3")).toBe("transcribe");
  });

  it("returns transcribe for .wav", () => {
    expect(inferTaskFromFile("recording.wav")).toBe("transcribe");
  });

  it("returns transcribe for .m4a", () => {
    expect(inferTaskFromFile("voice.m4a")).toBe("transcribe");
  });

  it("returns analyze for .jpg", () => {
    expect(inferTaskFromFile("photo.jpg")).toBe("analyze");
  });

  it("returns analyze for .mp4", () => {
    expect(inferTaskFromFile("video.mp4")).toBe("analyze");
  });

  it("returns analyze for .webm", () => {
    expect(inferTaskFromFile("clip.webm")).toBe("analyze");
  });

  it("returns extract for .pdf", () => {
    expect(inferTaskFromFile("doc.pdf")).toBe("extract");
  });

  it("returns extract for .txt", () => {
    expect(inferTaskFromFile("notes.txt")).toBe("extract");
  });

  it("defaults to analyze for unknown extension", () => {
    expect(inferTaskFromFile("file.xyz")).toBe("analyze");
  });
});

describe("getMimeType", () => {
  it("maps .jpg to image/jpeg", () => {
    expect(getMimeType("photo.jpg")).toBe("image/jpeg");
  });

  it("maps .mp4 to video/mp4", () => {
    expect(getMimeType("video.mp4")).toBe("video/mp4");
  });

  it("maps .pdf to application/pdf", () => {
    expect(getMimeType("doc.pdf")).toBe("application/pdf");
  });

  it("falls back to application/octet-stream for unknown", () => {
    expect(getMimeType("file.bin")).toBe("application/octet-stream");
  });
});

describe("requiresProcessingWait", () => {
  it("returns true for audio", () => {
    expect(requiresProcessingWait("audio/mp3")).toBe(true);
  });

  it("returns true for video", () => {
    expect(requiresProcessingWait("video/mp4")).toBe(true);
  });

  it("returns false for image", () => {
    expect(requiresProcessingWait("image/jpeg")).toBe(false);
  });
});
