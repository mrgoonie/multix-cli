/**
 * Per-model TTS request bodies: v4 and v4 Turbo fixtures, v3 and legacy
 * (multilingual v2, Flash) regressions, and the voice-setting compatibility
 * rules (reject what would be ignored, warn on no-ops, never drop silently).
 */

import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import { buildTtsRequest, checkVoiceId } from "../../../../src/providers/elevenlabs/tts-request.js";

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
    expect(() => buildTtsRequest({ text: "a".repeat(10_001), model: "eleven_v4" })).toThrow(
      /higher limit: eleven_flash_v2_5 \(40000\), eleven_flash_v2 \(30000\)/,
    );
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

describe("buildTtsRequest: checks carried over from the duplicate v4 implementation", () => {
  for (const model of ["eleven_v4", "eleven_v4_turbo"]) {
    it(`${model}: sends --clone-strength as voice_settings.clone_strength`, () => {
      const { payload, warnings } = buildTtsRequest({ text: "Hi", model, cloneStrength: "0.25" });
      expect(payload.voice_settings).toEqual({
        stability: 0.5,
        similarity_boost: 0.75,
        clone_strength: 0.25,
      });
      expect(warnings).toEqual([]);
    });
  }

  it.each(["eleven_v3", "eleven_multilingual_v2", "eleven_flash_v2_5"])(
    "rejects --clone-strength on %s (the API answers 400 unsupported_model)",
    (model) => {
      expect(() => buildTtsRequest({ text: "Hi", model, cloneStrength: "0" })).toThrow(
        /does not accept --clone-strength.*eleven_v4, eleven_v4_turbo/,
      );
    },
  );

  it.each(["1.5", "-0.1", "x"])("rejects --clone-strength %s", (cloneStrength) => {
    expect(() => buildTtsRequest({ text: "Hi", model: "eleven_v4", cloneStrength })).toThrow(
      /--clone-strength must be a number from 0 to 1/,
    );
  });

  it("counts text length in code points, as the API bills it", () => {
    const emoji = "😀".repeat(10_000); // 20,000 UTF-16 units, 10,000 characters
    expect(() => buildTtsRequest({ text: emoji, model: "eleven_v4" })).not.toThrow();
    expect(() => buildTtsRequest({ text: `${emoji}!`, model: "eleven_v4" })).toThrow(
      /at most 10000 characters per request \(got 10001\)/,
    );
  });

  it("warns that eleven_multilingual_v2 does not enforce --language-code, and still sends it", () => {
    const { payload, warnings } = buildTtsRequest({
      text: "Hallo",
      model: "eleven_multilingual_v2",
      languageCode: "de",
    });
    expect(payload.language_code).toBe("de");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/eleven_multilingual_v2 does not enforce --language-code/);
    expect(
      buildTtsRequest({ text: "Hi", model: "eleven_flash_v2_5", languageCode: "de" }).warnings,
    ).toEqual([]);
  });

  it("warns on SSML <break> for v3/v4, and on <phoneme> for every model but eleven_flash_v2", () => {
    const brk = 'Wait <break time="1s" /> now.';
    expect(buildTtsRequest({ text: brk, model: "eleven_v4" }).warnings[0]).toMatch(
      /eleven_v4 does not support SSML <break>/,
    );
    expect(buildTtsRequest({ text: brk, model: "eleven_v3" }).warnings[0]).toMatch(
      /eleven_v3 does not support SSML <break>/,
    );
    expect(buildTtsRequest({ text: brk, model: "eleven_flash_v2_5" }).warnings).toEqual([]);

    const ph = '<phoneme alphabet="ipa" ph="ˈæktʃuəli">actually</phoneme>';
    expect(buildTtsRequest({ text: ph, model: "eleven_flash_v2" }).warnings).toEqual([]);
    const v4 = buildTtsRequest({ text: ph, model: "eleven_v4" }).warnings;
    expect(v4).toHaveLength(1);
    expect(v4[0]).toMatch(/does not support SSML <phoneme>.*eleven_flash_v2.*IPA/);
    expect(buildTtsRequest({ text: ph, model: "eleven_multilingual_v2" }).warnings[0]).toMatch(
      /eleven_multilingual_v2 does not support SSML <phoneme>/,
    );
  });

  it("checkVoiceId accepts voice IDs and rejects path-unsafe input", () => {
    expect(() => checkVoiceId("kdmDKE6EkgrWrrykO9Qt")).not.toThrow();
    for (const bad of ["", "../voices", "abc/def", "a b", "id?x=1", "x".repeat(65)]) {
      expect(() => checkVoiceId(bad), bad).toThrow(ValidationError);
    }
  });
});
