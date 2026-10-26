/**
 * Model-specific checks of the ElevenLabs TTS request builder: Eleven v4 and
 * v4 Turbo get only the settings they use and reject the rest; v3 and the
 * older models keep their previous payload and only warn.
 */

import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import {
  TTS_MODEL_CAPABILITIES,
  ttsModelCapabilities,
} from "../../../../src/providers/elevenlabs/models.js";
import {
  type ExplicitOptions,
  type TtsOptions,
  buildTtsRequest,
} from "../../../../src/providers/elevenlabs/tts-request.js";

const DEFAULTS: TtsOptions = {
  text: "Hello there.",
  voice: "kdmDKE6EkgrWrrykO9Qt",
  model: "eleven_multilingual_v2",
  format: "mp3_44100_128",
  stability: "0.5",
  similarityBoost: "0.75",
  style: "0.0",
  speakerBoost: true,
};

/** Build with `over` applied; every key of `over` counts as set on the command line. */
function build(over: Partial<TtsOptions>) {
  const explicit = new Set(Object.keys(over)) as ExplicitOptions;
  return buildTtsRequest({ ...DEFAULTS, ...over }, explicit);
}

function fails(over: Partial<TtsOptions>): string {
  try {
    build(over);
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    return (err as Error).message;
  }
  throw new Error("expected a ValidationError");
}

describe.each(["eleven_v4", "eleven_v4_turbo"])("%s", (model) => {
  it("sends only stability and similarity_boost by default", () => {
    const req = build({ model });
    expect(req.endpoint).toBe("text-to-speech/kdmDKE6EkgrWrrykO9Qt");
    expect(req.query).toEqual({ output_format: "mp3_44100_128" });
    expect(req.payload).toEqual({
      text: "Hello there.",
      model_id: model,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    });
    expect(req.warnings).toEqual([]);
  });

  it("passes clone strength, language, seed, context text and audio tags", () => {
    const req = build({
      model,
      text: "[whispers] Hello there.",
      cloneStrength: "0.2",
      stability: "0.3",
      languageCode: "vi",
      seed: "42",
      previousText: "Before.",
      nextText: "After.",
    });
    expect(req.payload).toEqual({
      text: "[whispers] Hello there.",
      model_id: model,
      voice_settings: { stability: 0.3, similarity_boost: 0.75, clone_strength: 0.2 },
      language_code: "vi",
      seed: 42,
      previous_text: "Before.",
      next_text: "After.",
    });
    expect(req.warnings).toEqual([]);
  });

  it.each([
    [{ style: "0.4" }, "--style is not used by"],
    [{ speakerBoost: false }, "--no-speaker-boost is not used by"],
    [{ speed: "1.1" }, "--speed is not used by"],
  ])("rejects a setting the model ignores: %o", (over, message) => {
    expect(fails({ model, ...over })).toContain(message);
  });

  it("names the settings it does use and the models that take the rejected one", () => {
    const msg = fails({ model, style: "0.4" });
    expect(msg).toContain("--stability, --similarity-boost, --clone-strength");
    expect(msg).toContain("eleven_multilingual_v2");
  });

  it("allows 10,000 characters and rejects more", () => {
    expect(() => build({ model, text: "a".repeat(10_000) })).not.toThrow();
    expect(fails({ model, text: "a".repeat(10_001) })).toContain("at most 10000");
  });

  it("warns that SSML break tags are not supported and points at IPA", () => {
    const req = build({ model, text: 'Wait <break time="1s"/> now.' });
    expect(req.warnings).toHaveLength(1);
    expect(req.warnings[0]).toContain("IPA");
  });

  it("uses the with-timestamps endpoint on request", () => {
    expect(build({ model, timestamps: true }).endpoint).toBe(
      "text-to-speech/kdmDKE6EkgrWrrykO9Qt/with-timestamps",
    );
  });
});

describe("eleven_v3", () => {
  it("keeps the legacy voice settings object", () => {
    const req = build({ model: "eleven_v3" });
    expect(req.payload.voice_settings).toEqual({
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0,
      use_speaker_boost: true,
    });
    expect(req.warnings).toEqual([]);
  });

  it("rejects previous/next text, which the API refuses for v3", () => {
    expect(fails({ model: "eleven_v3", previousText: "x" })).toContain("not supported");
    expect(fails({ model: "eleven_v3", nextText: "x" })).toContain("eleven_v4");
  });

  it("warns about an explicit --style but still sends it", () => {
    const req = build({ model: "eleven_v3", style: "0.3" });
    expect(req.warnings[0]).toContain("--style is not used by eleven_v3");
    expect(req.payload.voice_settings).toMatchObject({ style: 0.3 });
  });

  it("rejects --clone-strength", () => {
    expect(fails({ model: "eleven_v3", cloneStrength: "0.1" })).toContain(
      "eleven_v4, eleven_v4_turbo",
    );
  });

  it("caps text at 5,000 characters", () => {
    expect(fails({ model: "eleven_v3", text: "a".repeat(5_001) })).toContain("at most 5000");
  });
});

describe("eleven_v3_conversational", () => {
  it("is verified, keeps speaker boost and rejects previous/next text", () => {
    const req = build({ model: "eleven_v3_conversational", speakerBoost: false });
    expect(req.warnings).toEqual([]);
    expect(req.payload.voice_settings).toMatchObject({ use_speaker_boost: false });
    expect(fails({ model: "eleven_v3_conversational", previousText: "x" })).toContain(
      "not supported",
    );
    expect(fails({ model: "eleven_v3_conversational", text: "a".repeat(5_001) })).toContain(
      "at most 5000",
    );
  });
});

describe("--speed", () => {
  it("is sent for the v2 family", () => {
    expect(build({ speed: "0.9" }).payload.voice_settings).toMatchObject({ speed: 0.9 });
    expect(
      build({ model: "eleven_flash_v2_5", speed: "1.2" }).payload.voice_settings,
    ).toMatchObject({ speed: 1.2 });
  });

  it("is omitted unless given", () => {
    expect(build({}).payload.voice_settings).not.toHaveProperty("speed");
  });

  it("rejects values outside 0.7..1.2, which the API refuses", () => {
    expect(fails({ speed: "1.5" })).toContain("--speed must be a number from 0.7 to 1.2");
    expect(fails({ speed: "0.5" })).toContain("--speed must be");
  });

  it("warns on eleven_v3, which ignores it", () => {
    const req = build({ model: "eleven_v3", speed: "1.1" });
    expect(req.warnings[0]).toContain("--speed is not used by eleven_v3");
  });
});

describe("legacy models", () => {
  it("multilingual_v2 sends the same payload as before", () => {
    const req = build({ previousText: "p", seed: "7" });
    expect(req.payload).toEqual({
      text: "Hello there.",
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
      seed: 7,
      previous_text: "p",
    });
    expect(req.warnings).toEqual([]);
  });

  it("multilingual_v2 warns that --language-code is ignored and still sends it", () => {
    const req = build({ languageCode: "en" });
    expect(req.warnings[0]).toContain("--language-code is ignored by eleven_multilingual_v2");
    expect(req.payload.language_code).toBe("en");
  });

  it("flash v2.5 warns about audio tags that would be read aloud", () => {
    const req = build({ model: "eleven_flash_v2_5", text: "[laughs] ok" });
    expect(req.warnings[0]).toContain("may be read aloud");
  });

  it("an unverified model id is sent unchecked with a warning", () => {
    const req = build({ model: "eleven_v9", style: "0.2", cloneStrength: "0.5" });
    expect(req.warnings[0]).toContain("not a verified ElevenLabs TTS model");
    expect(req.payload.voice_settings).toEqual({
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.2,
      use_speaker_boost: true,
      clone_strength: 0.5,
    });
  });
});

describe("input validation", () => {
  it.each([
    [{ voice: "../voices" }, "--voice must be an ElevenLabs voice ID"],
    [{ voice: "" }, "--voice must be"],
    [{ text: "" }, "--text or --prompt is required"],
    [{ model: "eleven_v4", format: "flac_44100" }, 'Unknown --format "flac_44100"'],
    [{ stability: "1.5" }, "--stability must be a number from 0 to 1"],
    [{ similarityBoost: "abc" }, "--similarity-boost must be"],
    [{ seed: "-1" }, "--seed must be an integer"],
    [{ seed: "1.5" }, "--seed must be an integer"],
    [{ seed: "4294967296" }, "--seed must be an integer"],
    [{ model: "eleven_v4", languageCode: "english" }, "--language-code should be an ISO 639"],
  ])("rejects %o", (over, message) => {
    expect(fails(over)).toContain(message);
  });

  it("older models only warn about an unknown format or language code, and still send them", () => {
    const req = build({
      model: "eleven_flash_v2_5",
      format: "flac_44100",
      languageCode: "english",
    });
    expect(req.warnings.join("\n")).toContain('Unknown --format "flac_44100"');
    expect(req.warnings.join("\n")).toContain("--language-code should be");
    expect(req.query.output_format).toBe("flac_44100");
    expect(req.payload.language_code).toBe("english");
  });

  it("accepts a regional language code", () => {
    expect(build({ model: "eleven_v4", languageCode: "pt-BR" }).payload.language_code).toBe(
      "pt-BR",
    );
  });

  it("counts characters as code points, so emoji are not overcounted", () => {
    expect(() => build({ model: "eleven_v3", text: "😀".repeat(5_000) })).not.toThrow();
    expect(fails({ model: "eleven_v3", text: "😀".repeat(5_001) })).toContain("5001 characters");
  });

  it("v4 reports an ignored setting before parsing its value", () => {
    expect(fails({ model: "eleven_v4", style: "abc" })).toContain("--style is not used by");
  });

  it("accepts the newer opus and wav formats", () => {
    expect(build({ model: "eleven_v4", format: "opus_48000_64" }).query.output_format).toBe(
      "opus_48000_64",
    );
    expect(() => build({ format: "wav_44100" })).not.toThrow();
  });
});

describe("capability table", () => {
  it("covers every listed model and matches the live catalog flags", () => {
    expect(ttsModelCapabilities("eleven_v4")?.voiceSettings).not.toContain("style");
    expect(ttsModelCapabilities("eleven_v4_turbo")?.strict).toBe(true);
    expect(ttsModelCapabilities("constructor")).toBeUndefined();
    expect(Object.keys(TTS_MODEL_CAPABILITIES)).toContain("eleven_v4_turbo");
  });
});
