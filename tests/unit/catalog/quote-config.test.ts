/**
 * Quote configuration from CLI flags: bounds, formats and the audio switch.
 * Fields left out are not assumed, so an empty input gives an empty config.
 */

import { describe, expect, it } from "vitest";
import { quoteConfig, taskOpt } from "../../../src/catalog/quote-config.js";
import { ValidationError } from "../../../src/core/errors.js";

describe("quoteConfig", () => {
  it("returns an empty config when no flag is given", () => {
    expect(quoteConfig({})).toEqual({});
  });

  it("maps flags to config fields and drops the ones left out", () => {
    expect(quoteConfig({ duration: "10" })).toEqual({ duration_s: 10 });
    expect(
      quoteConfig({ task: "video", resolution: "720p", aspectRatio: "16:9", count: "2" }),
    ).toEqual({
      task: "video",
      resolution: "720p",
      aspect_ratio: "16:9",
      count: 2,
    });
  });

  it("lower-cases the resolution", () => {
    expect(quoteConfig({ resolution: "4K" })).toEqual({ resolution: "4k" });
  });

  it("accepts a fractional duration", () => {
    expect(quoteConfig({ duration: "1.5" })).toEqual({ duration_s: 1.5 });
    expect(quoteConfig({ duration: 7 })).toEqual({ duration_s: 7 });
  });

  it.each([
    ["zero", "0"],
    ["negative", "-3"],
    ["above the hour", "3601"],
    ["not a number", "abc"],
    ["empty", ""],
    ["infinite", "Infinity"],
  ])("refuses a duration that is %s", (_label, duration) => {
    expect(() => quoteConfig({ duration })).toThrow(ValidationError);
    expect(() => quoteConfig({ duration })).toThrow(
      /--duration must be a number above 0 and at most 3600/,
    );
  });

  it("accepts the duration bound itself", () => {
    expect(quoteConfig({ duration: "3600" })).toEqual({ duration_s: 3600 });
  });

  it("bounds the count at 100", () => {
    expect(quoteConfig({ count: "100" })).toEqual({ count: 100 });
    expect(() => quoteConfig({ count: "101" })).toThrow(
      /--count must be a whole number above 0 and at most 100/,
    );
    expect(() => quoteConfig({ count: "0" })).toThrow(ValidationError);
    expect(() => quoteConfig({ count: "2.5" })).toThrow(/whole number/);
  });

  it.each(["7", "720 p", "720-p", "x", ""])("refuses resolution %j", (resolution) => {
    expect(() => quoteConfig({ resolution })).toThrow(/--resolution looks like 720p, 1080p or 4k/);
  });

  it("refuses an aspect ratio that is not N:M", () => {
    expect(() => quoteConfig({ aspectRatio: "16x9" })).toThrow(/--aspect-ratio looks like 16:9/);
    expect(() => quoteConfig({ aspectRatio: "169:9" })).toThrow(ValidationError);
    expect(quoteConfig({ aspectRatio: "9:16" })).toEqual({ aspect_ratio: "9:16" });
  });

  it("reads audio as on or off in any case, and accepts a boolean", () => {
    expect(quoteConfig({ audio: "on" })).toEqual({ audio: true });
    expect(quoteConfig({ audio: "OFF" })).toEqual({ audio: false });
    expect(quoteConfig({ audio: true })).toEqual({ audio: true });
    expect(quoteConfig({ audio: false })).toEqual({ audio: false });
  });

  it("refuses an audio value other than on or off", () => {
    expect(() => quoteConfig({ audio: "yes" })).toThrow(/--audio must be on or off/);
    expect(() => quoteConfig({ audio: "" })).toThrow(/--audio must be on or off/);
  });

  it("refuses an unknown task", () => {
    expect(() => quoteConfig({ task: "hologram" })).toThrow(/Unknown task "hologram"/);
  });
});

describe("taskOpt", () => {
  it("returns undefined without a value and the task when it is known", () => {
    expect(taskOpt(undefined)).toBeUndefined();
    expect(taskOpt("video")).toBe("video");
  });
});
