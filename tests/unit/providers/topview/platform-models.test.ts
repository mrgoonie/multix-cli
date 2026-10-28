/**
 * API Platform model registry and request building: the static list carries
 * its sources, flags map onto each family's own fields, --input conflicts are
 * errors, and the published schema plus per-mode rules are checked locally
 * before anything is sent.
 */

import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import {
  PLATFORM_MODELS,
  buildPlatformBody,
  findPlatformModel,
  requirePlatformModel,
  validatePlatformBody,
} from "../../../../src/providers/topview/platform-models.js";

const URL_A = "https://images.example.com/a.png";
const URL_B = "https://images.example.com/b.png";
const VIDEO = "https://videos.example.com/ref.mp4";

const model = (id: string) => requirePlatformModel(id);

describe("registry", () => {
  it("lists unique models with their schema, price and sources", () => {
    expect(PLATFORM_MODELS).toHaveLength(22);
    expect(new Set(PLATFORM_MODELS.map((m) => m.id)).size).toBe(PLATFORM_MODELS.length);
    for (const m of PLATFORM_MODELS) {
      expect(m.id).toBe(`${m.vendor}/${m.model}/${m.mode}`);
      expect(m.prices.length).toBeGreaterThan(0);
      expect(m.inputs.length).toBeGreaterThan(0);
      expect(m.source).toMatch(/^https:\/\/platform\.topview\.ai\//);
      expect(m.pricing_source).toBe("https://platform.topview.ai/pricing");
      expect(m.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("finds a model with stray slashes and rejects unknown ones", () => {
    expect(findPlatformModel("/alibaba/wan-3.0/text-to-video/")?.family).toBe("wan");
    expect(findPlatformModel("openai/dall-e/text-to-image")).toBeUndefined();
    expect(() => requirePlatformModel("openai/dall-e/text-to-image")).toThrow(ValidationError);
  });
});

describe("buildPlatformBody", () => {
  it("maps wan images to first/last frame media and settings to parameters", () => {
    const body = buildPlatformBody(model("alibaba/wan-3.0/image-to-video"), {
      prompt: "zoom in",
      images: [URL_A, URL_B],
      duration: 5,
      resolution: "720P",
    });
    expect(body).toEqual({
      input: {
        prompt: "zoom in",
        media: [
          { type: "first_frame", url: URL_A },
          { type: "last_frame", url: URL_B },
        ],
      },
      parameters: { duration: 5, resolution: "720P" },
    });
  });

  it("puts the prompt first in content and tags images with their role", () => {
    const body = buildPlatformBody(model("bytedance/seedance-2.0/image-to-video"), {
      prompt: "wave",
      images: [URL_A],
      ratio: "adaptive",
    });
    expect(body).toEqual({
      content: [
        { type: "text", text: "wave" },
        { type: "image_url", role: "first_frame", image_url: { url: URL_A } },
      ],
      ratio: "adaptive",
    });
  });

  it("uses reference_image for reference modes and image_urls for gpt-image", () => {
    const ref = buildPlatformBody(model("topview/topview-t1/omni-reference-to-video"), {
      images: [URL_A],
    });
    expect(ref.content).toEqual([
      { type: "image_url", role: "reference_image", image_url: { url: URL_A } },
    ]);
    const edit = buildPlatformBody(model("openai/gpt-image-2/edit"), {
      prompt: "make it blue",
      images: [URL_A],
      input: { image_urls: [URL_B] },
    });
    expect(edit.image_urls).toEqual([URL_B, URL_A]);
  });

  it("refuses a flag that contradicts --input, and accepts the same value", () => {
    const spec = model("topview/topview-t1/text-to-video");
    expect(() => buildPlatformBody(spec, { input: { duration: 5 }, duration: 10 })).toThrow(
      /--duration conflicts with "duration"/,
    );
    expect(buildPlatformBody(spec, { input: { duration: 5 }, duration: 5 }).duration).toBe(5);
    expect(() =>
      buildPlatformBody(spec, {
        prompt: "x",
        input: { content: [{ type: "text", text: "y" }] },
      }),
    ).toThrow(/--prompt conflicts/);
  });

  it("checks image counts per mode", () => {
    expect(() =>
      buildPlatformBody(model("alibaba/wan-3.0/text-to-video"), { images: [URL_A] }),
    ).toThrow(/takes no --image/);
    expect(() =>
      buildPlatformBody(model("minimax/minimax-h3/image-to-video"), {
        images: [URL_A, URL_B, URL_A],
      }),
    ).toThrow(/at most 2 --image/);
  });

  it("rejects video-only flags for gpt-image", () => {
    const spec = model("openai/gpt-image-2/text-to-image");
    expect(() => buildPlatformBody(spec, { prompt: "x", duration: 5 })).toThrow(/--duration/);
    expect(() => buildPlatformBody(spec, { prompt: "x", ratio: "16:9" })).toThrow(/"size"/);
  });
});

describe("validatePlatformBody", () => {
  const t1 = model("topview/topview-t1/text-to-video");
  const text = (t: string) => ({ type: "text", text: t });

  it("accepts a valid body", () => {
    expect(() => validatePlatformBody(t1, { content: [text("hi")], duration: 5 })).not.toThrow();
  });

  it("enforces the published schema", () => {
    expect(() => validatePlatformBody(t1, { content: [text("hi")], colour: "red" })).toThrow(
      /body.colour is not a documented field/,
    );
    expect(() => validatePlatformBody(t1, { content: [text("hi")], resolution: "4k" })).toThrow(
      /must be one of: 720p, 1080p/,
    );
    expect(() => validatePlatformBody(t1, { content: [text("hi")], duration: 5.5 })).toThrow(
      /must be an integer/,
    );
    expect(() => validatePlatformBody(t1, {})).toThrow(/body.content is required/);
  });

  it("checks the duration range, allowing -1 only where automatic is supported", () => {
    expect(() => validatePlatformBody(t1, { content: [text("hi")], duration: 31 })).toThrow(
      /4-30 seconds or -1/,
    );
    expect(() => validatePlatformBody(t1, { content: [text("hi")], duration: -1 })).not.toThrow();
    const minimax = model("minimax/minimax-h3/text-to-video");
    expect(() =>
      validatePlatformBody(minimax, { content: [text("hi")], ratio: "16:9", duration: -1 }),
    ).toThrow(/4-15 seconds$/);
  });

  it("requires a prompt for text-to-video", () => {
    expect(() =>
      validatePlatformBody(model("alibaba/wan-3.0/text-to-video"), {
        parameters: { duration: 5 },
      }),
    ).toThrow(/needs a prompt/);
  });

  it("requires a first frame, an image to edit, or a reference", () => {
    expect(() =>
      validatePlatformBody(model("topview/topview-t1/image-to-video"), {
        content: [text("hi")],
      }),
    ).toThrow(/first-frame image/);
    expect(() =>
      validatePlatformBody(model("openai/gpt-image-2/edit"), { prompt: "blue" }),
    ).toThrow(/at least one --image/);
    expect(() =>
      validatePlatformBody(model("topview/topview-t1/omni-reference-to-video"), {
        content: [text("hi")],
      }),
    ).toThrow(/at least one reference/);
  });

  it("requires a reference video for seedance 2.5/2.0 omni and enforces its limits", () => {
    const omni = model("bytedance/seedance-2.0/omni-reference-to-video");
    const image = { type: "image_url", image_url: { url: URL_A } };
    expect(() => validatePlatformBody(omni, { content: [text("hi"), image] })).toThrow(
      /reference video/,
    );
    const video = { type: "video_url", video_url: { url: VIDEO } };
    expect(() => validatePlatformBody(omni, { content: [text("hi"), video] })).not.toThrow();
    expect(() =>
      validatePlatformBody(omni, { content: [text("hi"), video, video, video, video] }),
    ).toThrow(/at most 9 images, 3 videos/);
    const mini = model("bytedance/seedance-2.0-mini/omni-reference-to-video");
    expect(() => validatePlatformBody(mini, { content: [text("hi"), image] })).not.toThrow();
  });

  it("needs a fixed ratio for minimax text-to-video", () => {
    const minimax = model("minimax/minimax-h3/text-to-video");
    expect(() => validatePlatformBody(minimax, { content: [text("hi")] })).toThrow(/--ratio/);
    expect(() =>
      validatePlatformBody(minimax, { content: [text("hi")], ratio: "adaptive" }),
    ).toThrow(/--ratio/);
    expect(() =>
      validatePlatformBody(minimax, { content: [text("hi")], ratio: "16:9" }),
    ).not.toThrow();
  });

  it("only sends public http(s) URLs", () => {
    const i2v = model("topview/topview-t1/image-to-video");
    const frame = (url: unknown) => ({
      content: [{ type: "image_url", role: "first_frame", image_url: { url } }],
    });
    expect(() => validatePlatformBody(i2v, frame("http://images.example.com/a.png"))).not.toThrow();
    for (const bad of [
      "http://127.0.0.1/a.png",
      "https://10.1.2.3/a.png",
      "http://localhost:8080/a.png",
      "file:///etc/passwd",
      "https://user:pass@images.example.com/a.png",
    ]) {
      expect(() => validatePlatformBody(i2v, frame(bad)), bad).toThrow(ValidationError);
    }
    expect(() =>
      validatePlatformBody(model("openai/gpt-image-2/edit"), {
        prompt: "x",
        image_urls: [URL_A],
        mask_url: "https://169.254.169.254/latest",
      }),
    ).toThrow(/mask_url must point to a public address/);
  });
});
