/**
 * Per-model TTS request bodies: v4 and v4 Turbo fixtures, v3 and legacy
 * (multilingual v2, Flash) regressions, and the voice-setting compatibility
 * rules (reject what would be ignored, warn on no-ops, never drop silently).
 */

import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import { buildTtsRequest } from "../../../../src/providers/elevenlabs/tts-request.js";

describe("buildTtsRequest: v4 family", () => {
  for (const model of ["eleven_v4", "eleven_v4_turbo"]) {
    it(`${model}: sends stability/similarity only, keeps context, seed and language`, () => {
      const { payload, warnings } = buildTtsRequest({
        text: "[whispering] Xin chào.",
        model,
        stability: "0.3",
        languageCode: "vi",
        seed: "42",
        previousText: "Trước đó.",
        nextText: "Sau đó.",
      });
      expect(payload).toEqual({
        text: "[whispering] Xin chào.",
        model_id: model,
        voice_settings: { stability: 0.3, similarity_boost: 0.75 },
        language_code: "vi",
        seed: 42,
        previous_text: "Trước đó.",
        next_text: "Sau đó.",
      });
      expect(warnings).toEqual([]);
    });

    it(`${model}: rejects a non-zero --style instead of letting the API ignore it`, () => {
      expect(() => buildTtsRequest({ text: "Hi", model, style: "0.4" })).toThrow(
        /has no style control.*eleven_multilingual_v2/,
      );
    });

    it(`${model}: --style 0 and --no-speaker-boost are reported, not sent`, () => {
      const { payload, warnings } = buildTtsRequest({
        text: "Hi",
        model,
        style: "0",
        speakerBoost: false,
      });
      expect(payload.voice_settings).toEqual({ stability: 0.5, similarity_boost: 0.75 });
      expect(warnings).toHaveLength(2);
      expect(warnings.join("\n")).toMatch(/--style 0 was not sent/);
      expect(warnings.join("\n")).toMatch(/--no-speaker-boost has no effect/);
    });
  }

  it("rejects text over the 10000-character v4 limit before any request", () => {
    expect(() => buildTtsRequest({ text: "a".repeat(10_001), model: "eleven_v4" })).toThrow(
      ValidationError,
    );
    expect(() => buildTtsRequest({ text: "a".repeat(10_000), model: "eleven_v4" })).not.toThrow();
  });
});

describe("buildTtsRequest: v3 and legacy regressions", () => {
  it("eleven_multilingual_v2 keeps the full legacy voice_settings body", () => {
    const { payload, warnings } = buildTtsRequest({
      text: "Hello",
      model: "eleven_multilingual_v2",
    });
    expect(payload).toEqual({
      text: "Hello",
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
    });
    expect(warnings).toEqual([]);
  });

  it("eleven_multilingual_v2 honours explicit style and --no-speaker-boost", () => {
    const { payload } = buildTtsRequest({
      text: "Hello",
      model: "eleven_multilingual_v2",
      style: "0.6",
      speakerBoost: false,
      similarityBoost: "0.9",
    });
    expect(payload.voice_settings).toEqual({
      stability: 0.5,
      similarity_boost: 0.9,
      style: 0.6,
      use_speaker_boost: false,
    });
  });

  it("eleven_v3 rejects previous/next text like the API does (400 unsupported_model)", () => {
    expect(() =>
      buildTtsRequest({ text: "Hi", model: "eleven_v3", previousText: "Before." }),
    ).toThrow(/eleven_v3 does not accept --previous-text\/--next-text.*eleven_v4/);
  });

  it("eleven_v3 rejects text over 5000 characters", () => {
    expect(() => buildTtsRequest({ text: "a".repeat(5_001), model: "eleven_v3" })).toThrow(
      /at most 5000 characters/,
    );
  });

  it("eleven_v3_conversational keeps speaker boost (can_use_speaker_boost)", () => {
    const { payload } = buildTtsRequest({ text: "Hi", model: "eleven_v3_conversational" });
    expect(payload.voice_settings).toEqual({
      stability: 0.5,
      similarity_boost: 0.75,
      use_speaker_boost: true,
    });
  });

  it("Flash/Turbo v2.x warn when the text carries audio tags they would read aloud", () => {
    const { warnings } = buildTtsRequest({ text: "[laughs] ok", model: "eleven_flash_v2_5" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/reads bracketed audio tags.*eleven_v4/);
  });

  it("unknown models pass options through unchecked, with a warning", () => {
    const { payload, warnings } = buildTtsRequest({
      text: "Hi",
      model: "eleven_v9",
      style: "0.2",
      previousText: "x",
    });
    expect(payload.voice_settings).toEqual({
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.2,
      use_speaker_boost: true,
    });
    expect(payload.previous_text).toBe("x");
    expect(warnings[0]).toMatch(/not in multix's ElevenLabs capability table/);
  });
});

describe("buildTtsRequest: value validation", () => {
  it.each([
    ["stability", "1.5"],
    ["stability", "abc"],
    ["similarityBoost", "-0.1"],
    ["style", ""],
  ])("rejects %s=%s", (key, value) => {
    expect(() =>
      buildTtsRequest({ text: "Hi", model: "eleven_multilingual_v2", [key]: value }),
    ).toThrow(/must be a number from 0 to 1/);
  });

  it.each(["-1", "1.5", "4294967296", "abc"])("rejects --seed %s", (seed) => {
    expect(() => buildTtsRequest({ text: "Hi", model: "eleven_v4", seed })).toThrow(
      /--seed must be an integer/,
    );
  });
});
