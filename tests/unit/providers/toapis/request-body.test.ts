import { describe, expect, it } from "vitest";
import { buildToapisBody, parseParams } from "../../../../src/providers/toapis/request-body.js";

describe("buildToapisBody", () => {
  it("maps Seedance frames to image_with_roles and video fields", () => {
    const body = buildToapisBody({
      kind: "video",
      model: "seedance-2-fast",
      prompt: "p",
      aspectRatio: "16:9",
      resolution: "480P",
      duration: 4,
      audio: false,
      firstFrame: "https://x/a.png",
    });
    expect(body).toEqual({
      model: "seedance-2-fast",
      prompt: "p",
      aspect_ratio: "16:9",
      resolution: "480p",
      duration: 4,
      generate_audio: false,
      image_with_roles: [{ url: "https://x/a.png", role: "first_frame" }],
    });
  });

  it("refuses Seedance frames together with reference images", () => {
    expect(() =>
      buildToapisBody({
        kind: "video",
        model: "seedance-2",
        prompt: "p",
        firstFrame: "https://x/a.png",
        images: ["https://x/b.png"],
      }),
    ).toThrow(/not both/);
  });

  it("puts image aspect in size and Seedream resolution in metadata", () => {
    const body = buildToapisBody({
      kind: "image",
      model: "doubao-seedream-4-5",
      prompt: "p",
      aspectRatio: "1:1",
      resolution: "2k",
      count: 2,
    });
    expect(body).toMatchObject({ size: "1:1", metadata: { resolution: "2K" }, n: 2 });
  });

  it("maps Kling resolution to mode and Veo official fields to metadata", () => {
    expect(
      buildToapisBody({ kind: "video", model: "kling-v3", prompt: "p", resolution: "1080p" }).mode,
    ).toBe("pro");
    const veo = buildToapisBody({
      kind: "video",
      model: "Veo3.1-fast-official",
      prompt: "p",
      aspectRatio: "16:9",
      audio: true,
      lastFrame: "https://x/z.png",
    });
    expect(veo).toMatchObject({
      size: "16:9",
      metadata: { generateAudio: true, lastFrame: "https://x/z.png" },
    });
  });

  it("uses reference_images for gpt-image and object urls for Gemini preview", () => {
    expect(
      buildToapisBody({ kind: "image", model: "gpt-image-2", prompt: "p", images: ["https://a"] })
        .reference_images,
    ).toEqual(["https://a"]);
    expect(
      buildToapisBody({
        kind: "image",
        model: "gemini-3-pro-image-preview",
        prompt: "p",
        images: ["https://a"],
      }).image_urls,
    ).toEqual([{ url: "https://a" }]);
  });

  it("merges --param extras with dotted keys last", () => {
    const body = buildToapisBody({
      kind: "image",
      model: "flux-2-pro",
      prompt: "p",
      resolution: "1K",
      extra: parseParams(["metadata.watermark=false", "style=vivid"]),
    });
    expect(body).toMatchObject({
      metadata: { resolution: "1K", watermark: false },
      style: "vivid",
    });
  });

  it("refuses --param keys the cost preflight prices", () => {
    for (const key of ["model", "n", "duration", "resolution", "metadata.resolution"]) {
      expect(() =>
        buildToapisBody({ kind: "video", model: "wan2.6", prompt: "p", extra: { [key]: 1 } }),
      ).toThrow(/is priced/);
    }
  });

  it("sends 720p to Seedance when no resolution is given", () => {
    expect(buildToapisBody({ kind: "video", model: "seedance-2", prompt: "p" }).resolution).toBe(
      "720p",
    );
  });

  it("rejects an empty prompt and a malformed param", () => {
    expect(() => buildToapisBody({ kind: "image", model: "m", prompt: " " })).toThrow();
    expect(() => parseParams(["novalue"])).toThrow(/key=value/);
  });
});
