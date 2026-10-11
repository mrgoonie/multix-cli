import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import { buildImageInput } from "../../../../src/providers/replicate/commands/image.js";
import { buildVideoInput } from "../../../../src/providers/replicate/commands/video.js";

const flow = { waitTimeout: "1000" };

describe("buildImageInput", () => {
  it("maps flags to FLUX-style input names and merges --input extras", () => {
    expect(
      buildImageInput("a red cube", {
        ...flow,
        aspectRatio: "16:9",
        numOutputs: "2",
        seed: "7",
        outputFormat: "png",
        input: '{"go_fast":false,"prompt":"ignored"}',
      }),
    ).toEqual({
      go_fast: false,
      prompt: "a red cube",
      aspect_ratio: "16:9",
      num_outputs: 2,
      seed: 7,
      output_format: "png",
    });
  });

  it("validates flag values", () => {
    expect(() => buildImageInput(" ", flow)).toThrow(ValidationError);
    expect(() => buildImageInput("x", { ...flow, aspectRatio: "wide" })).toThrow(/aspect/);
    expect(() => buildImageInput("x", { ...flow, numOutputs: "0" })).toThrow(/num-outputs/);
    expect(() => buildImageInput("x", { ...flow, seed: "-1" })).toThrow(/seed/);
    expect(() => buildImageInput("x", { ...flow, outputFormat: "gif" })).toThrow(/output-format/);
  });
});

describe("buildVideoInput", () => {
  it("maps flags to common video input names", () => {
    expect(
      buildVideoInput("a cat", {
        ...flow,
        imageKey: "image",
        duration: "5",
        aspectRatio: "9:16",
        resolution: "720p",
        input: '{"draft":true}',
      }),
    ).toEqual({
      draft: true,
      prompt: "a cat",
      duration: 5,
      aspect_ratio: "9:16",
      resolution: "720p",
    });
  });

  it("validates flag values", () => {
    const base = { ...flow, imageKey: "image" };
    expect(() => buildVideoInput("x", { ...base, duration: "1.5" })).toThrow(/duration/);
    expect(() => buildVideoInput("x", { ...base, resolution: "hd" })).toThrow(/resolution/);
    expect(() => buildVideoInput("x", { ...base, imageKey: "bad key" })).toThrow(/image-key/);
  });
});
