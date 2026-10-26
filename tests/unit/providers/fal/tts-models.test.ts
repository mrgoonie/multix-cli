/**
 * Contract of the typed fal TTS profiles: each endpoint gets its own field
 * names (from fal's live OpenAPI schemas), and anything the endpoint would
 * reject after queueing is refused before submit.
 */

import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import {
  FAL_TTS_PROFILES,
  buildTtsInput,
  findTtsProfile,
  outputForFormat,
} from "../../../../src/providers/fal/tts-models.js";

const GEMINI = "google/gemini-3.8-flash-tts";
const GEMINI_LITE = "google/gemini-3.8-flash-lite-tts";
const ELEVEN = "elevenlabs/tts/eleven-v4";
const ELEVEN_TURBO = "elevenlabs/tts/eleven-v4-turbo";

describe("typed fal TTS profiles", () => {
  it("covers the live Gemini 3.8 and ElevenLabs v4 endpoints, and no Fish Drama", () => {
    expect(FAL_TTS_PROFILES.map((p) => p.id)).toEqual([GEMINI, GEMINI_LITE, ELEVEN, ELEVEN_TURBO]);
    expect(FAL_TTS_PROFILES.some((p) => /fish/i.test(p.id))).toBe(false);
    expect(findTtsProfile(`/${GEMINI}/`)?.id).toBe(GEMINI);
  });

  it("Gemini: text goes to prompt, style to style_instructions, voice matched case-insensitively", () => {
    const { input, expectedOutput } = buildTtsInput(GEMINI_LITE, {
      text: "Xin chào",
      voice: "kore",
      style: "warm, slow",
    });
    expect(input).toEqual({ prompt: "Xin chào", voice: "Kore", style_instructions: "warm, slow" });
    expect(expectedOutput).toBe("wav");
  });

  it("ElevenLabs: text goes to text, format and language map to output_format and language_code", () => {
    const { input, expectedOutput } = buildTtsInput(ELEVEN, {
      text: "[excited] Hello",
      voice: "Aria",
      format: "pcm_24000",
      language: "en",
    });
    expect(input).toEqual({
      text: "[excited] Hello",
      voice: "Aria",
      output_format: "pcm_24000",
      language_code: "en",
    });
    expect(expectedOutput).toBe("pcm");
    expect(buildTtsInput(ELEVEN_TURBO, { text: "hi" }).expectedOutput).toBe("mp3");
  });

  it("refuses what each endpoint has no field for, before anything is submitted", () => {
    expect(() => buildTtsInput(GEMINI, { text: "hi", format: "mp3_44100_128" })).toThrow(
      /--format is not supported by google\/gemini-3.8-flash-tts: it always returns WAV/,
    );
    expect(() => buildTtsInput(GEMINI, { text: "hi", language: "en" })).toThrow(/--language/);
    expect(() => buildTtsInput(ELEVEN, { text: "hi", style: "calm" })).toThrow(/audio tags/);
    expect(() => buildTtsInput(GEMINI, { text: "hi", voice: "Rachel" })).toThrow(
      /Invalid voice "Rachel".*Valid: Achernar/,
    );
    expect(() => buildTtsInput(ELEVEN, { text: "hi", format: "wav" })).toThrow(/Invalid --format/);
    expect(() => buildTtsInput(ELEVEN, { text: "hi", language: "english!" })).toThrow(
      /Invalid --language/,
    );
    expect(() => buildTtsInput(ELEVEN, { text: "hi", textField: "prompt" })).toThrow(
      /--text-field does not apply/,
    );
  });

  it("requires non-blank text and enforces the ElevenLabs 5000-character limit", () => {
    for (const model of [GEMINI, ELEVEN]) {
      expect(() => buildTtsInput(model, { text: "   " })).toThrow(ValidationError);
      expect(() => buildTtsInput(model, {})).toThrow(/Provide the text to speak/);
    }
    expect(() => buildTtsInput(ELEVEN, { text: "a".repeat(5001) })).toThrow(/at most 5000/);
    expect(buildTtsInput(ELEVEN, { text: "a".repeat(5000) }).input.text).toHaveLength(5000);
  });

  it("Gemini dialogue: speakers and turns from --input replace the text", () => {
    const turns = [{ speaker_id: "A", text: "Hi" }];
    const speakers = [
      { speaker_id: "A", voice: "Kore" },
      { speaker_id: "B", voice: "Puck" },
    ];
    expect(buildTtsInput(GEMINI, { extra: { speakers, turns } }).input).toEqual({
      speakers,
      turns,
    });
    expect(() => buildTtsInput(GEMINI, { text: "Hi", extra: { turns } })).toThrow(/Omit the text/);
    expect(() => buildTtsInput(ELEVEN, { extra: { turns } })).toThrow(/Provide the text/);
  });

  it("refuses a field set both by a flag and by --input", () => {
    expect(() => buildTtsInput(ELEVEN, { text: "hi", extra: { text: "other" } })).toThrow(
      /Set text with the text or --input, not both/,
    );
    expect(() =>
      buildTtsInput(GEMINI, { text: "hi", voice: "Puck", extra: { voice: "Kore" } }),
    ).toThrow(/--voice or --input/);
    // An output_format given through --input still sets the expected container.
    expect(
      buildTtsInput(ELEVEN, { text: "hi", extra: { output_format: "opus_48000_64" } }),
    ).toMatchObject({
      input: { text: "hi", output_format: "opus_48000_64" },
      expectedOutput: "opus",
    });
  });

  it("untyped ids: text goes to --text-field (default text), extras pass through, typed-only flags refused", () => {
    expect(
      buildTtsInput("fal-ai/kokoro/american-english", { text: "hi", voice: "af_heart" }),
    ).toEqual({
      input: { text: "hi", voice: "af_heart" },
    });
    expect(
      buildTtsInput("fal-ai/minimax/speech-2.8-hd", {
        text: "hi",
        textField: "prompt",
        extra: { voice_setting: { voice_id: "Wise_Woman" } },
      }).input,
    ).toEqual({ prompt: "hi", voice_setting: { voice_id: "Wise_Woman" } });
    expect(() => buildTtsInput("fal-ai/x/tts", { text: "hi", style: "calm" })).toThrow(
      /no typed profile/,
    );
    for (const textField of ["__proto__", "a.b", ""]) {
      expect(() => buildTtsInput("fal-ai/x/tts", { text: "hi", textField })).toThrow(
        /Invalid --text-field/,
      );
    }
  });

  it("maps ElevenLabs output formats to containers", () => {
    expect(outputForFormat("mp3_44100_128")).toBe("mp3");
    expect(outputForFormat("pcm_16000")).toBe("pcm");
    expect(outputForFormat("ulaw_8000")).toBe("ulaw");
    expect(outputForFormat("opus_48000_32")).toBe("opus");
  });
});
