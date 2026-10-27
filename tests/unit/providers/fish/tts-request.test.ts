/**
 * Fish Audio TTS request planning: body shape, UTF-8 byte count, voice ids,
 * multi-speaker tags, pronunciation dictionaries and parameter ranges. Pure;
 * nothing is sent.
 */

import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import { FISH_PUBLIC_VOICES } from "../../../../src/providers/fish/models.js";
import {
  type FishTtsInput,
  parseDictionaryRef,
  planFishTts,
  resolveFishVoice,
  speakerIndexes,
  turnsToSpeakerText,
  utf8Length,
  validateDictionaries,
} from "../../../../src/providers/fish/tts-request.js";

const VOICE_A = "aaaabbbbccccddddeeeeffff00001111";
const VOICE_B = "2222333344445555666677778888aaaa";

const plan = (over: Partial<FishTtsInput> = {}) =>
  planFishTts({ model: "drama-3", text: "Hello there.", voices: [], format: "mp3", ...over });

describe("planFishTts", () => {
  it("sends the text exactly as written, tags included, and counts UTF-8 bytes", () => {
    const text = "[whispering] Xin chào <|phoneme_start|>t o m ɑ t o<|phoneme_end|>";
    const result = plan({ text });
    expect(result.body).toEqual({ text, format: "mp3" });
    expect(result.utf8Bytes).toBe(new TextEncoder().encode(text).byteLength);
    expect(result.utf8Bytes).toBeGreaterThan(text.length);
    expect(result.warnings).toEqual([]);
  });

  it("uses a string reference_id for one voice and maps public names to ids", () => {
    expect(plan({ voices: ["Adrian"] }).body.reference_id).toBe(FISH_PUBLIC_VOICES.adrian);
    expect(plan({ voices: [VOICE_A] }).body.reference_id).toBe(VOICE_A);
  });

  it("uses a reference_id array for tagged multi-speaker text", () => {
    const result = plan({
      text: "<|speaker:0|>Hi.<|speaker:1|>Hello.<|speaker:0|>Bye.",
      voices: [VOICE_A, VOICE_B],
    });
    expect(result.body.reference_id).toEqual([VOICE_A, VOICE_B]);
    expect(result.speakers).toEqual([0, 1]);
  });

  it("rejects multi-speaker text the request cannot carry", () => {
    expect(() => plan({ model: "s1", text: "<|speaker:0|>Hi", voices: [VOICE_A] })).toThrow(
      /one voice/,
    );
    expect(() => plan({ voices: [VOICE_A, VOICE_B] })).toThrow(/no <\|speaker:N\|> tags/);
    expect(() =>
      plan({ text: "<|speaker:0|>Hi<|speaker:2|>Yo", voices: [VOICE_A, VOICE_B] }),
    ).toThrow(/speaker:2/);
  });

  it("warns, without failing, on unbalanced phoneme tags and unused voices", () => {
    const result = plan({
      text: "<|speaker:0|>Say <|phoneme_start|>t o",
      voices: [VOICE_A, VOICE_B],
    });
    expect(result.warnings.join("\n")).toMatch(/unbalanced phoneme tags/);
    expect(result.warnings.join("\n")).toMatch(/1 voice\(s\) are not used/);
  });

  it("maps options to the documented body fields", () => {
    const result = plan({
      format: "opus",
      sampleRate: 48_000,
      opusBitrate: 32_000,
      temperature: 0.7,
      topP: 0.8,
      speed: 1.2,
      volume: -3,
      normalizeLoudness: false,
      chunkLength: 200,
      normalize: false,
      language: "vi",
      latency: "balanced",
    });
    expect(result.body).toEqual({
      text: "Hello there.",
      format: "opus",
      sample_rate: 48_000,
      opus_bitrate: 32_000,
      temperature: 0.7,
      top_p: 0.8,
      prosody: { speed: 1.2, volume: -3, normalize_loudness: false },
      chunk_length: 200,
      normalize: false,
      language: "vi",
      latency: "balanced",
    });
  });

  it.each([
    [{ text: "   " }, /empty/],
    [{ text: "a".repeat(200_001) }, /UTF-8 bytes/],
    [{ temperature: 1.5 }, /--temperature/],
    [{ topP: -0.1 }, /--top-p/],
    [{ speed: 3 }, /--speed/],
    [{ volume: Number.NaN }, /--volume/],
    [{ chunkLength: 50 }, /--chunk-length/],
    [{ sampleRate: 22_050.5 }, /--sample-rate/],
    [{ sampleRate: 16_000 }, /--sample-rate for mp3 must be one of 32000, 44100/],
    [{ format: "wav" as const, sampleRate: 22_050 }, /--sample-rate for wav/],
    [{ chunkLength: 150.5 }, /--chunk-length must be a whole number/],
    [{ format: "opus" as const, sampleRate: 44_100 }, /Opus output is 48000/],
    [{ mp3Bitrate: 128, format: "wav" as const }, /--format mp3 only/],
    [{ mp3Bitrate: 96 }, /64, 128, 192/],
    [{ opusBitrate: 24_000 }, /--format opus only/],
    [{ language: "en US" }, /--language/],
    [{ latency: "fast" }, /--latency/],
    [{ voices: ["not a voice!"] }, /not a Fish Audio voice id/],
  ])("rejects %o", (over, message) => {
    expect(() => plan(over)).toThrow(ValidationError);
    expect(() => plan(over)).toThrow(message);
  });

  it("warns that Fish skips an unresolvable dictionary reference", () => {
    const result = plan({ dictionaries: [{ id: "dict_1", version: "ver_9" }] });
    expect(result.body.pronunciation_dictionary).toEqual([{ id: "dict_1", version: "ver_9" }]);
    expect(result.warnings.join("\n")).toMatch(/does not prove the dictionary was applied/);
  });
});

describe("validateDictionaries", () => {
  const inline = { items: [{ key: "Nguyen", value: "win", case_sensitive: true }] };

  it("accepts up to three inline or three reference dictionaries", () => {
    expect(validateDictionaries([inline])).toEqual([inline]);
    expect(
      validateDictionaries([
        { id: "a", version: "b" },
        { id: "c", version: "d" },
      ]),
    ).toEqual([
      { id: "a", version: "b" },
      { id: "c", version: "d" },
    ]);
  });

  it.each([
    [[], /1 to 3/],
    [[inline, inline, inline, inline], /1 to 3/],
    [[inline, { id: "a", version: "b" }], /cannot mix/],
    [[{ id: "a", version: "latest" }], /pin a published version/],
    [[{ id: "a", version: "V2" }], /pin a published version/],
    [[{ id: "a b", version: "x" }], /"id" must match/],
    [[{ id: "a", version: "b", extra: 1 }], /unexpected field/],
    [[{ items: [] }], /1 to 5000 items/],
    [[{ items: [{ key: "a", value: "<|phoneme_start|>a" }] }], /must not contain/],
    [[{ items: [{ key: "a", value: "b", case_sensitive: "yes" }] }], /case_sensitive/],
    [[{ items: [{ key: "a", value: "b", note: "x" }] }], /unexpected field/],
    [[{ items: [{ key: "a".repeat(257), value: "b" }] }], /"key" must be 1 to 256/],
  ])("rejects %j", (value, message) => {
    expect(() => validateDictionaries(value)).toThrow(message);
  });

  it("parses id@version and refuses a missing version", () => {
    expect(parseDictionaryRef("dict_1@ver_2")).toEqual({ id: "dict_1", version: "ver_2" });
    expect(() => parseDictionaryRef("dict_1")).toThrow(/pinned version/);
    expect(() => parseDictionaryRef("dict_1@")).toThrow(/pinned version/);
  });
});

describe("speaker helpers", () => {
  it("turns dialogue into tagged text with one voice per distinct speaker", () => {
    const result = turnsToSpeakerText([
      { text: "Hi.", voice: "adrian" },
      { text: "Hello.", voice: VOICE_B },
      { text: "Bye.", voice: "Adrian" },
    ]);
    expect(result).toEqual({
      text: "<|speaker:0|>Hi.<|speaker:1|>Hello.<|speaker:0|>Bye.",
      voices: [FISH_PUBLIC_VOICES.adrian, VOICE_B],
    });
    expect(speakerIndexes(result.text)).toEqual([0, 1]);
  });

  it("resolves voices and counts bytes", () => {
    expect(resolveFishVoice(" delia ")).toBe(FISH_PUBLIC_VOICES.delia);
    expect(() => resolveFishVoice("https://fish.audio/m/x")).toThrow(/voice id/);
    expect(utf8Length("é")).toBe(2);
  });
});
