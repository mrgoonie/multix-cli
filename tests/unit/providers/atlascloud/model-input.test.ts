import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import {
  FIELD_CANDIDATES as F,
  buildModelInput,
  parseModelSpec,
  validateRawInput,
} from "../../../../src/providers/atlascloud/model-input.js";
import type { AtlasModelSpec } from "../../../../src/providers/atlascloud/types.js";
import { FLUX_SCHNELL_SCHEMA, SEEDANCE_T2V_SCHEMA, modelSchemaDoc } from "./fake-atlas.js";

const flux = parseModelSpec(
  "black-forest-labs/flux-schnell",
  FLUX_SCHNELL_SCHEMA,
) as AtlasModelSpec;
const seedance = parseModelSpec(
  "bytedance/seedance-v1-pro-fast/text-to-video",
  SEEDANCE_T2V_SCHEMA,
) as AtlasModelSpec;
// openai/gpt-image-1-mini/edit takes `images: string[]` and `1024x1024` sizes.
const gptEdit = parseModelSpec(
  "openai/gpt-image-1-mini/edit",
  modelSchemaDoc(
    "Image",
    {
      images: { type: "array", items: { type: "string" }, maxItems: 4 },
      prompt: { type: "string" },
      size: { type: "string", enum: ["1024x1024", "1024x1536", "1536x1024"], default: "1024x1024" },
    },
    ["model", "images", "prompt"],
  ),
) as AtlasModelSpec;
// seedance image-to-video takes a single `image` string.
const seedanceI2v = parseModelSpec(
  "bytedance/seedance-v1-pro-fast/image-to-video",
  modelSchemaDoc(
    "Video",
    { image: { type: "string" }, prompt: { type: "string" }, generate_audio: { type: "boolean" } },
    ["model", "prompt", "image"],
  ),
) as AtlasModelSpec;

describe("parseModelSpec", () => {
  it("takes the endpoint from the schema's submit path", () => {
    expect(flux.endpoint).toBe("image");
    expect(seedance.endpoint).toBe("video");
    // A catalog "Image" model served by generateVideo resolves to video.
    expect(parseModelSpec("x", modelSchemaDoc("Video", { prompt: {} }, []))?.endpoint).toBe(
      "video",
    );
  });

  it("returns undefined for documents without an input schema", () => {
    expect(parseModelSpec("x", null)).toBeUndefined();
    expect(parseModelSpec("x", { paths: {} })).toBeUndefined();
  });
});

describe("buildModelInput", () => {
  it("maps flags onto each model's own field names and types", () => {
    const body = buildModelInput(flux, [
      { flag: "--prompt", value: "a fox", candidates: F.prompt },
      { flag: "--size", value: "512*512", candidates: F.size },
      { flag: "--num-images", value: "2", candidates: F.numImages },
    ]);
    expect(body).toEqual({ prompt: "a fox", size: "512*512", num_images: 2 });
  });

  it("uses images[] for edit models and image for single-image video models", () => {
    const edit = buildModelInput(gptEdit, [
      { flag: "--prompt", value: "make it dusk", candidates: F.prompt },
      { flag: "--ref", value: ["https://x.test/a.png"], candidates: F.editImages },
    ]);
    expect(edit.images).toEqual(["https://x.test/a.png"]);

    const i2v = buildModelInput(seedanceI2v, [
      { flag: "--prompt", value: "pan", candidates: F.prompt },
      { flag: "--ref", value: ["https://x.test/a.png"], candidates: F.primaryImage },
    ]);
    expect(i2v.image).toBe("https://x.test/a.png");
  });

  it("rejects several refs for a single-image field", () => {
    expect(() =>
      buildModelInput(seedanceI2v, [
        { flag: "--prompt", value: "pan", candidates: F.prompt },
        { flag: "--ref", value: ["a.png", "b.png"], candidates: F.primaryImage },
      ]),
    ).toThrow(/single value/);
  });

  it("enforces maxItems", () => {
    expect(() =>
      buildModelInput(gptEdit, [
        { flag: "--prompt", value: "x", candidates: F.prompt },
        { flag: "--ref", value: ["1", "2", "3", "4", "5"], candidates: F.editImages },
      ]),
    ).toThrow(/at most 4/);
  });

  it("validates enums with the model's valid values", () => {
    expect(() =>
      buildModelInput(seedance, [
        { flag: "--prompt", value: "waves", candidates: F.prompt },
        { flag: "--duration", value: "30", candidates: F.duration },
      ]),
    ).toThrow(/Valid duration: 2, 3/);
    const ok = buildModelInput(seedance, [
      { flag: "--prompt", value: "waves", candidates: F.prompt },
      { flag: "--duration", value: "5", candidates: F.duration },
      { flag: "--resolution", value: "720p", candidates: F.resolution },
    ]);
    expect(ok).toMatchObject({ duration: 5, resolution: "720p" });
  });

  it("enforces numeric ranges and types", () => {
    expect(() =>
      buildModelInput(flux, [
        { flag: "--prompt", value: "x", candidates: F.prompt },
        { flag: "--num-images", value: "9", candidates: F.numImages },
      ]),
    ).toThrow(/maximum 4/);
    expect(() =>
      buildModelInput(flux, [
        { flag: "--prompt", value: "x", candidates: F.prompt },
        { flag: "--seed", value: "abc", candidates: F.seed },
      ]),
    ).toThrow(ValidationError);
  });

  it("names the model and its inputs when a flag is unsupported", () => {
    expect(() =>
      buildModelInput(flux, [
        { flag: "--prompt", value: "x", candidates: F.prompt },
        { flag: "--duration", value: "5", candidates: F.duration },
      ]),
    ).toThrow(/black-forest-labs\/flux-schnell does not accept --duration.*prompt, size/);
  });

  it.each([
    ["--duration", true],
    ["[text]", true],
    ["duration", false],
  ])("suggests `multix atlas run` only for CLI input %s", (flag, hinted) => {
    const run = () => buildModelInput(flux, [{ flag, value: "5", candidates: F.duration }]);
    expect(run).toThrow(hinted ? /Use `multix atlas run black-forest-labs/ : /Its inputs: [^`]*$/);
  });

  it("reports missing required fields with the flag to pass", () => {
    expect(() =>
      buildModelInput(gptEdit, [
        { flag: "--prompt", value: "x", candidates: F.prompt },
        { flag: "--ref", value: [], candidates: F.editImages },
      ]),
    ).toThrow(/requires: images \(pass --ref\)/);
  });

  it("fills required defaults but never a placeholder prompt", () => {
    const tts = parseModelSpec(
      "xai/tts-v1",
      modelSchemaDoc(
        "Audio",
        { text: { type: "string" }, language: { type: "string", default: "auto" } },
        ["model", "text", "language"],
      ),
    ) as AtlasModelSpec;
    expect(
      buildModelInput(tts, [{ flag: "[text]", value: "hi", candidates: F.speechText }]),
    ).toEqual({
      text: "hi",
      language: "auto",
    });
    expect(() => buildModelInput(flux, [])).toThrow(/requires: prompt/);
  });

  it("does not put a URL into a same-named boolean field", () => {
    const videoWithAudioFlag = parseModelSpec(
      "v",
      modelSchemaDoc("Video", { audio: { type: "boolean" }, prompt: { type: "string" } }, []),
    ) as AtlasModelSpec;
    expect(() =>
      buildModelInput(videoWithAudioFlag, [
        { flag: "--audio", value: "https://x.test/a.mp3", candidates: F.audioInput },
      ]),
    ).toThrow(/does not accept --audio/);
  });

  it("maps STT input to audio_url or audio per model", () => {
    const seedAsr = parseModelSpec(
      "bytedance/seed-asr-2.0",
      modelSchemaDoc("Audio", { audio_url: { type: "string" } }, ["model", "audio_url"]),
    ) as AtlasModelSpec;
    const xaiStt = parseModelSpec(
      "xai/stt-v1",
      modelSchemaDoc("Audio", { audio: { type: "string", default: "" } }, ["model", "audio"]),
    ) as AtlasModelSpec;
    const req = [{ flag: "--audio", value: "https://x.test/a.mp3", candidates: F.audioInput }];
    expect(buildModelInput(seedAsr, req)).toEqual({ audio_url: "https://x.test/a.mp3" });
    expect(buildModelInput(xaiStt, req)).toEqual({ audio: "https://x.test/a.mp3" });
    expect(() => buildModelInput(xaiStt, [])).toThrow(/requires: audio/);
  });

  it("falls back to the first candidate when no schema is available", () => {
    expect(
      buildModelInput(undefined, [
        { flag: "--prompt", value: "x", candidates: F.prompt },
        { flag: "--ref", value: ["u"], candidates: F.editImages },
        { flag: "--seed", value: undefined, candidates: F.seed },
      ]),
    ).toEqual({ prompt: "x", images: ["u"] });
  });

  it("sends the usual types when no schema is available", () => {
    expect(
      buildModelInput(undefined, [
        { flag: "--prompt", value: "pan", candidates: F.prompt },
        { flag: "--ref", value: ["https://x.test/f.png"], candidates: F.primaryImage },
        { flag: "--seed", value: "42", candidates: F.seed },
        { flag: "--duration", value: "5", candidates: F.duration },
        { flag: "--num-images", value: "2", candidates: F.numImages },
      ]),
    ).toEqual({
      prompt: "pan",
      image: "https://x.test/f.png",
      seed: 42,
      duration: 5,
      num_images: 2,
    });
    expect(() =>
      buildModelInput(undefined, [
        { flag: "--ref", value: ["a", "b"], candidates: F.primaryImage },
      ]),
    ).toThrow(/single value/);
    expect(() =>
      buildModelInput(undefined, [{ flag: "--seed", value: "abc", candidates: F.seed }]),
    ).toThrow(ValidationError);
  });
});

describe("validateRawInput", () => {
  it("returns undeclared fields and checks declared ones", () => {
    const body: Record<string, unknown> = { prompt: "x", resolution: "720p", fancy: 1 };
    expect(validateRawInput(seedance, body)).toEqual(["fancy"]);
    expect(() => validateRawInput(seedance, { prompt: "x", resolution: "4k" })).toThrow(
      /Valid resolution/,
    );
    expect(() => validateRawInput(seedance, { resolution: "720p" })).toThrow(/requires: prompt/);
  });
});
