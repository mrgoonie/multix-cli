/**
 * Tests for buildVideoTaskBody — flag-in-prompt vs structured params modes,
 * image inputs, and references with roles.
 */

import { describe, expect, it } from "vitest";
import { buildVideoTaskBody } from "../../../../src/providers/byteplus/generators/video.js";
import type { ResolvedRef } from "../../../../src/providers/byteplus/types.js";

describe("buildVideoTaskBody — flags mode (default)", () => {
  it("encodes params inline as flags in content[0].text", () => {
    const body = buildVideoTaskBody({
      model: "seedance-2.0",
      prompt: "ocean waves",
      resolution: "1080p",
      duration: 8,
      aspectRatio: "16:9",
      seed: 42,
      cameraFixed: true,
      paramsMode: "flags",
    });
    expect(body.model).toBe("seedance-2.0");
    expect(body.content).toHaveLength(1);
    const text = (body.content[0] as { text: string }).text;
    expect(text).toContain("ocean waves");
    expect(text).toContain("--rs 1080p");
    expect(text).toContain("--dur 8");
    expect(text).toContain("--rt 16:9");
    expect(text).toContain("--cf true");
    expect(text).toContain("--seed 42");
    expect(body.parameters).toBeUndefined();
  });

  it("appends image_url entries for imageInputs", () => {
    const body = buildVideoTaskBody({
      model: "seedance-2.0",
      prompt: "p",
      paramsMode: "flags",
      imageInputs: [{ kind: "url", url: "https://x/y.jpg" }],
    });
    expect(body.content).toHaveLength(2);
    expect(body.content[1]).toMatchObject({
      type: "image_url",
      image_url: { url: "https://x/y.jpg" },
    });
  });

  it("appends multimodal refs ordered by kind", () => {
    const refs: ResolvedRef[] = [
      { kind: "image", url: "https://x/a.jpg", role: "subject" },
      { kind: "video", url: "https://x/b.mp4", role: "style" },
      { kind: "audio", url: "https://x/c.mp3", role: "audio" },
    ];
    const body = buildVideoTaskBody({
      model: "seedance-2.0",
      prompt: "p",
      paramsMode: "flags",
      references: refs,
    });
    expect(body.content).toHaveLength(4);
    expect(body.content[1]).toMatchObject({
      type: "image_url",
      image_url: { url: "https://x/a.jpg", role: "subject" },
    });
    expect(body.content[2]).toMatchObject({
      type: "video_url",
      video_url: { url: "https://x/b.mp4", role: "style" },
    });
    expect(body.content[3]).toMatchObject({
      type: "audio_url",
      audio_url: { url: "https://x/c.mp3", role: "audio" },
    });
  });
});

describe("buildVideoTaskBody — structured mode", () => {
  it("emits top-level parameters object", () => {
    const body = buildVideoTaskBody({
      model: "seedance-2.0",
      prompt: "ocean waves",
      resolution: "1080p",
      duration: 8,
      aspectRatio: "16:9",
      seed: 42,
      paramsMode: "structured",
    });
    expect((body.content[0] as { text: string }).text).toBe("ocean waves");
    expect(body.parameters).toEqual({
      resolution: "1080p",
      duration: 8,
      aspect_ratio: "16:9",
      seed: 42,
    });
  });
});
