/**
 * Flag validation against catalog rows: every flag a row does not confirm is
 * refused before anything is uploaded or sent.
 */

import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import { parseCatalogModel } from "../../../../src/providers/sume/models.js";
import {
  type SumeFlags,
  flagsFromOptions,
  planSumeRequest,
  withMedia,
} from "../../../../src/providers/sume/request-plan.js";
import type { SumeModel } from "../../../../src/providers/sume/types.js";
import { AVATAR, CAPTIONS, LAYERED, NANO, RESTYLE, SEEDANCE, SEEDREAM, VEO } from "./fake-sume.js";

const row = (raw: unknown) => parseCatalogModel(raw) as SumeModel;

function plan(command: "image" | "video", raw: unknown, flags: SumeFlags, prompt?: string) {
  return planSumeRequest({ command, model: row(raw), flags, prompt });
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return (error as Error).message;
  }
  throw new Error("expected a ValidationError");
}

describe("image", () => {
  it("builds the body from flags the row lists", () => {
    const p = plan(
      "image",
      NANO,
      {
        aspectRatio: "16:9",
        resolution: "2K",
        numImages: "2",
        outputFormat: "webp",
        image: ["a.png", "https://x.test/b.png"],
      },
      "a cat",
    );
    expect(p.router).toBe("image");
    expect(p.body).toEqual({
      model: "nano-banana-2.1",
      prompt: "a cat",
      aspect_ratio: "16:9",
      resolution: "2K",
      num_images: 2,
      output_format: "webp",
    });
    expect(p.media).toEqual([
      {
        field: "image_urls",
        flag: "--image",
        values: ["a.png", "https://x.test/b.png"],
        list: true,
        media: "image",
      },
    ]);
    const urls = new Map([
      [p.media[0] as (typeof p.media)[number], ["https://u/1", "https://u/2"]],
    ]);
    expect(withMedia(p, urls).image_urls).toEqual(["https://u/1", "https://u/2"]);
  });

  it.each([
    [
      NANO,
      { resolution: "8K" },
      /--resolution 8K is not supported by nano-banana-2.1. Use one of: 1K, 2K, 4K/,
    ],
    [NANO, { quality: "high" }, /does not list any quality values/],
    [NANO, { numImages: "5" }, /--num-images must be from 1 to 4/],
    [NANO, { numImages: "two" }, /whole number/],
    [NANO, { duration: "5" }, /--duration is a video flag/],
    [SEEDREAM, { resolution: "1K" }, /does not list any resolution values/],
    [NANO, { imageSize: "huge!" }, /WIDTHxHEIGHT/],
    [LAYERED, {}, /edits images only: pass --image/],
    [
      NANO,
      { param: ["seed=1"] },
      /--param seed is not a request field of nano-banana-2.1. Fields it lists for --param: none listed/,
    ],
    [NANO, { param: ["model=other"] }, /set by multix/],
    [NANO, { param: ["aspect_ratio=1:1"] }, /use --aspect-ratio instead/],
  ])("refuses %#", (raw, flags, message) => {
    expect(refusal(() => plan("image", raw, flags as SumeFlags, "x"))).toMatch(message);
  });

  it("needs a prompt and caps its length", () => {
    expect(refusal(() => plan("image", NANO, {}))).toMatch(/needs a prompt/);
    expect(refusal(() => plan("image", NANO, {}, "  "))).toMatch(/must not be empty/);
    expect(refusal(() => plan("image", NANO, {}, "x".repeat(20_001)))).toMatch(/at most 20000/);
  });

  it("fills a required field from its default (qwen-image-layered num_images)", () => {
    expect(plan("image", LAYERED, { image: ["a.png"] }, "split").body.num_images).toBe(2);
    expect(
      refusal(() => plan("image", LAYERED, { image: ["a.png"], numImages: "11" }, "x")),
    ).toMatch(/from 2 to 10/);
  });

  it("refuses a video model on sume image and the reverse", () => {
    expect(refusal(() => plan("image", VEO, {}, "x"))).toMatch(
      /veo-3.1 is a video model; use sume video/,
    );
    expect(refusal(() => plan("video", NANO, {}, "x"))).toMatch(
      /is an image model; use sume image/,
    );
  });
});

describe("video", () => {
  it("builds a text-to-video body", () => {
    const p = plan(
      "video",
      VEO,
      { duration: "6", resolution: "1080p", aspectRatio: "9:16", generateAudio: false },
      "waves",
    );
    expect(p.body).toEqual({
      model: "veo-3.1",
      prompt: "waves",
      duration: 6,
      resolution: "1080p",
      aspect_ratio: "9:16",
      generate_audio: false,
    });
    expect(p.media).toEqual([]);
  });

  it("takes first frame, end frame and reference images when the row allows them", () => {
    const p = plan(
      "video",
      SEEDANCE,
      { image: ["f.png"], endImage: "e.png", referenceImage: ["r1.png", "r2.png"] },
      "x",
    );
    expect(p.media.map((m) => [m.field, m.list])).toEqual([
      ["image_url", false],
      ["end_image_url", false],
      ["reference_image_urls", true],
    ]);
  });

  it.each([
    [VEO, { duration: "5" }, /--duration must be one of 4, 6, 8 seconds/],
    [VEO, { image: ["a.png"] }, /does not take a first-frame image/],
    [VEO, { video: "v.mp4" }, /does not take a source video/],
    [VEO, { audio: "a.mp3" }, /--audio is for lip-sync models/],
    [SEEDANCE, { duration: "16" }, /--duration must be from 4 to 15/],
    [SEEDANCE, { endImage: "e.png" }, /--end-image needs --image/],
    [SEEDANCE, { referenceImage: ["1", "2", "3"] }, /at most 2 --reference-image/],
    [SEEDANCE, { image: ["a.png", "b.png"] }, /takes one --image/],
    [SEEDANCE, { quality: "high" }, /--quality is an image flag/],
    [AVATAR, { image: ["face.png"], audio: "s.mp3" }, /needs --duration/],
    [
      AVATAR,
      { image: ["face.png"], duration: "10" },
      /lip-sync model: pass the speech with --audio/,
    ],
    [AVATAR, { audio: "s.mp3", duration: "10" }, /pass the face with --image/],
    [
      { ...SEEDANCE, capabilities: { ...SEEDANCE.capabilities, text_to_video: false } },
      {},
      /does not make video from text alone \(modes: text-to-video, image-to-video, reference-to-video\)/,
    ],
    [AVATAR, { image: ["f"], audio: "a", duration: "61" }, /must be from 2 to 60/],
    [AVATAR, { image: ["f"], audio: "a", duration: "10", generateAudio: true }, /--generate-audio/],
    [RESTYLE, { video: "v.mp4" }, /special Sume route.*not supported by multix/],
  ])("refuses %#", (raw, flags, message) => {
    expect(refusal(() => plan("video", raw, flags as SumeFlags, "x"))).toMatch(message);
  });

  it("builds a lip-sync body", () => {
    const p = plan("video", AVATAR, { image: ["face.png"], audio: "speech.mp3", duration: "12" });
    expect(p.body).toEqual({ model: "kling-avatar-2.0", duration: 12 });
    expect(p.media.map((m) => [m.field, m.media])).toEqual([
      ["image_url", "image"],
      ["audio_url", "audio"],
    ]);
  });

  it("types --param values and nests dotted keys", () => {
    const p = plan("video", CAPTIONS, {
      video: "clip.mp4",
      duration: "30",
      param: ["captions.style=bold", "captions.max_words=4"],
    });
    expect(p.body).toEqual({
      model: "veed-subtitles",
      duration: 30,
      captions: { style: "bold", max_words: 4 },
    });
    expect(
      refusal(() =>
        plan("video", CAPTIONS, { video: "c", duration: "3", param: ["captions.style=neon"] }),
      ),
    ).toMatch(/Use one of: classic, bold/);
    expect(
      refusal(() =>
        plan("video", CAPTIONS, { video: "c", duration: "3", param: ["captions.max_words=11"] }),
      ),
    ).toMatch(/at most 10/);
    expect(refusal(() => plan("video", CAPTIONS, { video: "c", duration: "3" }, "words"))).toMatch(
      /does not take a prompt/,
    );
  });
});

describe("flagsFromOptions", () => {
  it("reads commander camelCase and MCP kebab-case spellings", () => {
    expect(
      flagsFromOptions({
        aspectRatio: "16:9",
        "num-images": 2,
        "--reference-image": ["a", "b"],
        generateAudio: false,
        param: "k=v",
      }),
    ).toEqual({
      aspectRatio: "16:9",
      numImages: "2",
      referenceImage: ["a", "b"],
      generateAudio: false,
      param: ["k=v"],
    });
  });
});
