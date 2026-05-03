/**
 * Tests for parseRefSpec — path:role syntax with Windows path / colon escape edge cases.
 */

import { describe, expect, it } from "vitest";
import {
  REF_LIMITS,
  parseRefSpec,
  validateRefCounts,
} from "../../../../src/providers/byteplus/reference-input.js";
import type { ResolvedRef } from "../../../../src/providers/byteplus/types.js";

describe("parseRefSpec", () => {
  it("parses path:role", () => {
    expect(parseRefSpec("./photo.jpg:subject")).toEqual({
      path: "./photo.jpg",
      role: "subject",
    });
  });

  it("returns path with no role when no colon", () => {
    expect(parseRefSpec("./photo.jpg")).toEqual({ path: "./photo.jpg" });
  });

  it("treats Windows drive prefix as path, not role", () => {
    expect(parseRefSpec("C:\\Users\\me\\photo.jpg")).toEqual({
      path: "C:\\Users\\me\\photo.jpg",
    });
  });

  it("honors backslash-colon escape", () => {
    expect(parseRefSpec("path\\:with\\:colons:role")).toEqual({
      path: "path:with:colons",
      role: "role",
    });
  });

  it("parses URL with role", () => {
    expect(parseRefSpec("https\\://example.com/x.jpg:style")).toEqual({
      path: "https://example.com/x.jpg",
      role: "style",
    });
  });
});

describe("validateRefCounts", () => {
  function refs(image: number, video: number, audio: number): ResolvedRef[] {
    const out: ResolvedRef[] = [];
    for (let i = 0; i < image; i++) out.push({ kind: "image", url: "x" });
    for (let i = 0; i < video; i++) out.push({ kind: "video", url: "x" });
    for (let i = 0; i < audio; i++) out.push({ kind: "audio", url: "x" });
    return out;
  }

  it("accepts within limits", () => {
    expect(() => validateRefCounts(refs(REF_LIMITS.image, 0, 0))).not.toThrow();
    expect(() => validateRefCounts(refs(0, REF_LIMITS.video, REF_LIMITS.audio))).not.toThrow();
  });

  it("rejects when image refs exceed limit", () => {
    expect(() => validateRefCounts(refs(REF_LIMITS.image + 1, 0, 0))).toThrow(/image refs/);
  });

  it("rejects when total exceeds 12", () => {
    expect(() => validateRefCounts(refs(9, 3, 1))).toThrow(/Too many references/);
  });
});
