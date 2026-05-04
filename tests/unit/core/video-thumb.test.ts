import { describe, expect, it } from "vitest";
import { detectThumbUrl } from "../../../src/core/video-thumb.js";

describe("detectThumbUrl", () => {
  it("returns null for null/undefined/primitives", () => {
    expect(detectThumbUrl(null)).toBeNull();
    expect(detectThumbUrl(undefined)).toBeNull();
    expect(detectThumbUrl("nope")).toBeNull();
    expect(detectThumbUrl(42)).toBeNull();
  });

  it("finds a top-level cover_image_url image", () => {
    expect(detectThumbUrl({ cover_image_url: "https://x.test/c.jpg" })).toBe(
      "https://x.test/c.jpg",
    );
  });

  it("matches camelCase variants", () => {
    expect(detectThumbUrl({ thumbnailUrl: "https://x.test/t.png" })).toBe("https://x.test/t.png");
  });

  it("walks nested objects and arrays", () => {
    const obj = {
      response: { videos: [{ first_frame_url: "https://x.test/f.webp" }] },
    };
    expect(detectThumbUrl(obj)).toBe("https://x.test/f.webp");
  });

  it("ignores non-image extensions", () => {
    expect(detectThumbUrl({ thumb_url: "https://x.test/c.mp4" })).toBeNull();
  });

  it("ignores non-http URLs", () => {
    expect(detectThumbUrl({ thumb_url: "data:image/png;base64,abc" })).toBeNull();
  });

  it("ignores unknown keys even if value is an image URL", () => {
    expect(detectThumbUrl({ random_key: "https://x.test/c.jpg" })).toBeNull();
  });

  it("accepts URLs with query strings", () => {
    expect(detectThumbUrl({ cover_url: "https://x.test/c.jpg?sig=abc" })).toBe(
      "https://x.test/c.jpg?sig=abc",
    );
  });
});
