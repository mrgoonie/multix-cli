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

describe("buildTtsRequest: --clone-strength", () => {
  for (const model of ["eleven_v4", "eleven_v4_turbo"]) {
    it(`${model}: sends voice_settings.clone_strength`, () => {
      const { payload } = buildTtsRequest({ text: "Hi", model, cloneStrength: "0.3" });
      expect(payload.voice_settings).toEqual({
        stability: 0.5,
        similarity_boost: 0.75,
        clone_strength: 0.3,
      });
    });
  }

  it("is left out of the body unless set", () => {
    const { payload } = buildTtsRequest({ text: "Hi", model: "eleven_v4" });
    expect(payload.voice_settings).not.toHaveProperty("clone_strength");
  });

  it.each([
    "eleven_v3",
    "eleven_v3_conversational",
    "eleven_multilingual_v2",
    "eleven_flash_v2_5",
    "eleven_flash_v2",
    "eleven_turbo_v2_5",
    "eleven_turbo_v2",
  ])("%s rejects it like the API does (400 unsupported_model)", (model) => {
    expect(() => buildTtsRequest({ text: "Hi", model, cloneStrength: "0" })).toThrow(
      new RegExp(`${model} does not accept --clone-strength.*eleven_v4, eleven_v4_turbo`),
    );
  });

  it.each(["1.5", "-0.1", "x", ""])("rejects --clone-strength %s", (value) => {
    expect(() => buildTtsRequest({ text: "Hi", model: "eleven_v4", cloneStrength: value })).toThrow(
      /--clone-strength must be a number from 0 to 1/,
    );
  });

  it("an unknown model gets it unchecked", () => {
    const { payload } = buildTtsRequest({ text: "Hi", model: "eleven_v9", cloneStrength: "0.2" });
    expect(payload.voice_settings).toMatchObject({ clone_strength: 0.2 });
  });
});

describe("buildTtsRequest: text length in code points", () => {
  it("counts an astral character once, as ElevenLabs bills it", () => {
    // U+20000 is two UTF-16 units but one character.
    const text = "\u{20000}".repeat(5_000);
    expect(text.length).toBe(10_000);
    expect(() => buildTtsRequest({ text, model: "eleven_v3" })).not.toThrow();
    expect(() => buildTtsRequest({ text: `${text}a`, model: "eleven_v3" })).toThrow(
      /at most 5000 characters per request \(got 5001\)/,
    );
  });
});

describe("buildTtsRequest: SSML warnings", () => {
  const BREAK = 'Hi. <break time="1.5s" /> Bye.';
  const PHONEME =
    'Say <phoneme alphabet="ipa" ph="t\u0259\u02c8me\u026a\u027eo\u028a">tomato</phoneme>.';

  it.each(["eleven_v4", "eleven_v4_turbo", "eleven_v3", "eleven_v3_conversational"])(
    "%s warns that <break> gives no pause",
    (model) => {
      const { warnings } = buildTtsRequest({ text: BREAK, model });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(
        /skips SSML <break> tags.*eleven_multilingual_v2, eleven_flash_v2_5, eleven_flash_v2, eleven_turbo_v2_5, eleven_turbo_v2/,
      );
    },
  );

  it.each([
    "eleven_multilingual_v2",
    "eleven_flash_v2_5",
    "eleven_flash_v2",
    "eleven_turbo_v2_5",
    "eleven_turbo_v2",
  ])("%s pauses for <break> and does not warn", (model) => {
    expect(buildTtsRequest({ text: BREAK, model }).warnings).toEqual([]);
  });

  it.each(["eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5"])(
    "%s warns that a <phoneme> word is dropped",
    (model) => {
      const { warnings } = buildTtsRequest({ text: PHONEME, model });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/drops words wrapped in SSML <phoneme> tags.*eleven_v4/);
    },
  );

  it.each([
    "eleven_v4",
    "eleven_v4_turbo",
    "eleven_v3",
    "eleven_v3_conversational",
    "eleven_flash_v2",
    "eleven_turbo_v2",
  ])("%s speaks <phoneme> and does not warn", (model) => {
    expect(buildTtsRequest({ text: PHONEME, model }).warnings).toEqual([]);
  });

  it("plain text with angle brackets is not mistaken for SSML", () => {
    expect(buildTtsRequest({ text: "a < b > c", model: "eleven_v4" }).warnings).toEqual([]);
  });
});

describe("checkVoiceId", () => {
  it.each(["kdmDKE6EkgrWrrykO9Qt", "voice_1-a"])("accepts %s", (id) => {
    expect(() => checkVoiceId(id)).not.toThrow();
  });

  it.each(["..", ".", "a b", "../models", "abc/def", "x".repeat(65), ""])(
    "rejects %j before it reaches the URL path",
    (id) => {
      expect(() => checkVoiceId(id)).toThrow(/--voice must be an ElevenLabs voice ID/);
    },
  );
});

describe("buildTtsRequest: --language-code", () => {
  it("eleven_multilingual_v2 sends it with a warning that it is not enforced", () => {
    const { payload, warnings } = buildTtsRequest({
      text: "Hallo",
      model: "eleven_multilingual_v2",
      languageCode: "de",
    });
    expect(payload.language_code).toBe("de");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /eleven_multilingual_v2 does not enforce --language-code.*eleven_v4/,
    );
  });

  it.each(["eleven_v4", "eleven_v3", "eleven_flash_v2_5"])(
    "%s sends it without a warning",
    (model) => {
      const { payload, warnings } = buildTtsRequest({ text: "Hallo", model, languageCode: "de" });
      expect(payload.language_code).toBe("de");
      expect(warnings).toEqual([]);
    },
  );
});
