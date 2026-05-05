/**
 * Tests for buildThreeDTaskBody — text-to-3D, image-to-3D, raw flag pass-through,
 * seed encoding, and input validation.
 */

import { describe, expect, it } from "vitest";
import {
  buildThreeDTaskBody,
  inferModelFileExt,
} from "../../../../src/providers/byteplus/generators/three-d.js";

describe("buildThreeDTaskBody — text-to-3D", () => {
  it("emits a single text content item with prompt + flags concatenated", () => {
    const body = buildThreeDTaskBody({
      model: "hyper3d-gen2-260112",
      prompt: "Quadrupedal mech robot",
      flags: "--mesh_mode Raw --hd_texture true",
      seed: 8648,
    });
    expect(body.model).toBe("hyper3d-gen2-260112");
    expect(body.seed).toBe(8648);
    expect(body.content).toHaveLength(1);
    const text = (body.content[0] as { text: string }).text;
    expect(text).toBe("Quadrupedal mech robot --mesh_mode Raw --hd_texture true");
  });

  it("omits seed when undefined", () => {
    const body = buildThreeDTaskBody({
      model: "hyper3d-gen2-260112",
      prompt: "robot",
    });
    expect(body.seed).toBeUndefined();
  });

  it("works with prompt only (no flags)", () => {
    const body = buildThreeDTaskBody({
      model: "hyper3d-gen2-260112",
      prompt: "a tiny cabin",
    });
    expect((body.content[0] as { text: string }).text).toBe("a tiny cabin");
  });
});

describe("buildThreeDTaskBody — image-to-3D", () => {
  it("appends image_url entries after the text segment", () => {
    const body = buildThreeDTaskBody({
      model: "hitem3d-2-0-251223",
      flags: "--ff 2 --resolution 1536pro",
      imageInputs: [
        { kind: "url", url: "https://x/front.png" },
        { kind: "url", url: "https://x/side.png" },
      ],
    });
    expect(body.content).toHaveLength(3);
    expect((body.content[0] as { text: string }).text).toBe("--ff 2 --resolution 1536pro");
    expect(body.content[1]).toMatchObject({
      type: "image_url",
      image_url: { url: "https://x/front.png" },
    });
    expect(body.content[2]).toMatchObject({
      type: "image_url",
      image_url: { url: "https://x/side.png" },
    });
  });

  it("works with images alone (no prompt, no flags)", () => {
    const body = buildThreeDTaskBody({
      model: "hitem3d-2-0-251223",
      imageInputs: [{ kind: "url", url: "https://x/cat.png" }],
    });
    expect(body.content).toHaveLength(1);
    expect(body.content[0]).toMatchObject({
      type: "image_url",
      image_url: { url: "https://x/cat.png" },
    });
  });

  it("inlines data URLs from local file resolutions", () => {
    const body = buildThreeDTaskBody({
      model: "hyper3d-gen2-260112",
      prompt: "p",
      imageInputs: [
        { kind: "data", dataUrl: "data:image/png;base64,AAA", mime: "image/png", bytes: 3 },
      ],
    });
    expect(body.content[1]).toMatchObject({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAA" },
    });
  });
});

describe("buildThreeDTaskBody — validation", () => {
  it("throws when neither prompt nor images are provided", () => {
    expect(() => buildThreeDTaskBody({ model: "hyper3d-gen2-260112" })).toThrow(
      /prompt or .* image/,
    );
  });

  it("treats whitespace-only prompts as empty", () => {
    expect(() => buildThreeDTaskBody({ model: "hyper3d-gen2-260112", prompt: "   " })).toThrow();
  });
});

describe("inferModelFileExt", () => {
  it("detects common 3D model extensions", () => {
    expect(inferModelFileExt("https://x/model.glb")).toBe("glb");
    expect(inferModelFileExt("https://x/scene.gltf")).toBe("gltf");
    expect(inferModelFileExt("https://x/asset.zip?token=abc")).toBe("zip");
    expect(inferModelFileExt("https://x/MODEL.OBJ#frag")).toBe("obj");
  });

  it("falls back to glb when no recognised extension", () => {
    expect(inferModelFileExt("https://x/something")).toBe("glb");
    expect(inferModelFileExt("https://x/no-ext.bin")).toBe("glb");
  });
});
