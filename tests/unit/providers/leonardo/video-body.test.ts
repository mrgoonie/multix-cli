/**
 * Unit tests for the v1 text-to-video request body: `leonardo video` has no
 * --duration, so the Kling models must not fall back to an unknown length.
 */

import { describe, expect, it } from "vitest";
import { v1TextToVideoBody } from "../../../../src/providers/leonardo/commands/video.js";

describe("v1TextToVideoBody", () => {
  it("sends 5 s for the v1 Kling models", () => {
    for (const model of ["KLING2_1", "Kling2_5"]) {
      expect(v1TextToVideoBody("waves", model, { resolution: "RESOLUTION_720" })).toEqual({
        prompt: "waves",
        model,
        resolution: "RESOLUTION_720",
        promptEnhance: false,
        frameInterpolation: false,
        duration: 5,
      });
    }
  });

  it("sends no duration for models with a fixed length", () => {
    const body = v1TextToVideoBody("waves", "MOTION2", {
      resolution: "RESOLUTION_480",
      enhance: true,
    });
    expect(body).not.toHaveProperty("duration");
    expect(body).toMatchObject({ promptEnhance: true, resolution: "RESOLUTION_480" });
  });
});
