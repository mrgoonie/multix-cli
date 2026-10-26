/**
 * ElevenLabs TTS request building per model: v4 / v4 Turbo send only the
 * settings they use, legacy v2/v3 keep their historical defaults, and flags a
 * model would silently drop are rejected before any paid request.
 */

import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import {
  ELEVENLABS_TTS_CAPS,
  ELEVENLABS_TTS_MODELS,
} from "../../../../src/providers/elevenlabs/models.js";
import { buildTtsRequest, parseSetting } from "../../../../src/providers/elevenlabs/tts-request.js";

const base = { text: "Hello there.", settings: {} };

describe("buildTtsRequest", () => {
  it.each(["eleven_v4", "eleven_v4_turbo"])("%s sends no voice settings unless passed", (model) => {
    const { payload, warnings } = buildTtsRequest({ ...base, model });
    expect(payload).toEqual({ text: "Hello there.", model_id: model });
    expect(warnings).toEqual([]);
  });

  it.each(["eleven_v4", "eleven_v4_turbo"])(
    "%s accepts stability, similarity and clone strength",
    (model) => {
      const { payload } = buildTtsRequest({
        ...base,
        model,
        settings: { stability: 0.3, similarity_boost: 0.9, clone_strength: 0.2 },
        languageCode: "vi",
        seed: 42,
        previousText: "Before.",
        nextText: "After.",
      });
      expect(payload).toEqual({
        text: "Hello there.",
        model_id: model,
        voice_settings: { stability: 0.3, similarity_boost: 0.9, clone_strength: 0.2 },
        language_code: "vi",
        seed: 42,
        previous_text: "Before.",
        next_text: "After.",
      });
    },
  );

  it.each([
    ["style", { style: 0.4 }, "--style"],
    ["speed", { speed: 1.1 }, "--speed"],
    ["speaker boost", { use_speaker_boost: true }, "--speaker-boost"],
  ] as const)("eleven_v4 rejects %s instead of silently ignoring it", (_name, settings, flag) => {
    expect(() => buildTtsRequest({ ...base, model: "eleven_v4", settings })).toThrow(
      ValidationError,
    );
    expect(() => buildTtsRequest({ ...base, model: "eleven_v4", settings })).toThrow(
      new RegExp(`${flag}.*not supported by eleven_v4`),
    );
  });

  it("names the models that do support a rejected setting", () => {
    expect(() =>
      buildTtsRequest({ ...base, model: "eleven_v4_turbo", settings: { style: 0.2 } }),
    ).toThrow(/Models that use it: eleven_multilingual_v2/);
  });

  it("eleven_v3 keeps the historical stability/similarity defaults and takes no speed", () => {
    expect(buildTtsRequest({ ...base, model: "eleven_v3" }).payload.voice_settings).toEqual({
      stability: 0.5,
      similarity_boost: 0.75,
    });
    expect(() => buildTtsRequest({ ...base, model: "eleven_v3", settings: { speed: 1 } })).toThrow(
      /--speed is not supported by eleven_v3/,
    );
  });

  it("eleven_multilingual_v2 keeps the full legacy voice settings and merges overrides", () => {
    const { payload } = buildTtsRequest({
      ...base,
      model: "eleven_multilingual_v2",
      settings: { style: 0.3, use_speaker_boost: false, speed: 1.1 },
    });
    expect(payload.voice_settings).toEqual({
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.3,
      use_speaker_boost: false,
      speed: 1.1,
    });
  });

  it("flash and turbo v2 models accept speed but not style or clone strength", () => {
    for (const model of [
      "eleven_flash_v2_5",
      "eleven_turbo_v2_5",
      "eleven_flash_v2",
      "eleven_turbo_v2",
    ]) {
      expect(
        buildTtsRequest({ ...base, model, settings: { speed: 0.9 } }).payload.voice_settings,
      ).toEqual({ stability: 0.5, similarity_boost: 0.75, speed: 0.9 });
      expect(() => buildTtsRequest({ ...base, model, settings: { style: 0.1 } })).toThrow(
        /--style/,
      );
      expect(() => buildTtsRequest({ ...base, model, settings: { clone_strength: 0.1 } })).toThrow(
        /--clone-strength/,
      );
    }
  });

  it("validates ranges and seed before any request", () => {
    expect(() =>
      buildTtsRequest({ ...base, model: "eleven_v4", settings: { stability: 1.5 } }),
    ).toThrow(/--stability must be between 0 and 1/);
    expect(() =>
      buildTtsRequest({ ...base, model: "eleven_flash_v2_5", settings: { speed: 2 } }),
    ).toThrow(/--speed must be between 0.7 and 1.2/);
    expect(() => buildTtsRequest({ ...base, model: "eleven_v4", seed: 1.5 })).toThrow(/--seed/);
    expect(() => buildTtsRequest({ ...base, model: "eleven_v4", seed: -1 })).toThrow(/--seed/);
  });

  it("enforces each model's per-request character limit", () => {
    const long = "a".repeat(5_001);
    expect(() => buildTtsRequest({ ...base, text: long, model: "eleven_v3" })).toThrow(
      /5001 characters; eleven_v3 accepts at most 5000/,
    );
    expect(buildTtsRequest({ ...base, text: long, model: "eleven_v4" }).payload.text).toBe(long);
    expect(() =>
      buildTtsRequest({ ...base, text: "a".repeat(10_001), model: "eleven_v4_turbo" }),
    ).toThrow(/at most 10000/);
  });

  it("warns when audio tags or SSML would not be understood", () => {
    expect(
      buildTtsRequest({ ...base, text: "[whispering] hi", model: "eleven_multilingual_v2" })
        .warnings[0],
    ).toMatch(/does not interpret audio tags/);
    expect(
      buildTtsRequest({ ...base, text: "[whispering] hi", model: "eleven_v4" }).warnings,
    ).toEqual([]);
    expect(
      buildTtsRequest({ ...base, text: 'Wait <break time="1s" /> ok', model: "eleven_v4" })
        .warnings[0],
    ).toMatch(/does not support SSML/);
  });

  it("passes unknown models through with only explicit settings and a warning", () => {
    const { payload, warnings } = buildTtsRequest({
      ...base,
      model: "eleven_v5_preview",
      settings: { style: 0.2 },
    });
    expect(payload).toEqual({
      text: "Hello there.",
      model_id: "eleven_v5_preview",
      voice_settings: { style: 0.2 },
    });
    expect(warnings[0]).toMatch(/Unknown ElevenLabs model "eleven_v5_preview"/);
  });

  it("has capabilities for every listed TTS model", () => {
    for (const model of ELEVENLABS_TTS_MODELS) {
      expect(ELEVENLABS_TTS_CAPS[model].maxChars).toBeGreaterThan(0);
      for (const key of Object.keys(ELEVENLABS_TTS_CAPS[model].defaults)) {
        expect(ELEVENLABS_TTS_CAPS[model].settings).toContain(key);
      }
    }
  });
});

describe("parseSetting", () => {
  it("parses numbers and rejects garbage", () => {
    expect(parseSetting("--stability", undefined)).toBeUndefined();
    expect(parseSetting("--stability", "0.4")).toBe(0.4);
    expect(() => parseSetting("--stability", "high")).toThrow(/--stability must be a number/);
    expect(() => parseSetting("--seed", "")).toThrow(/--seed must be a number/);
  });
});
