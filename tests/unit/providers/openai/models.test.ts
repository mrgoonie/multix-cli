import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENAI_IMAGE_MODEL,
  DEFAULT_OPENAI_STT_MODEL,
  DEFAULT_OPENAI_TTS_MODEL,
  OPENAI_TTS_VOICES,
  extFromAudioFormat,
  extFromImageFormat,
  parseNumImages,
  resolveTranscriptionRequestFormat,
  validateKnownSpeakerPairing,
} from "../../../../src/providers/openai/models.js";

describe("OpenAI model defaults", () => {
  it("uses current OpenAI defaults", () => {
    expect(DEFAULT_OPENAI_IMAGE_MODEL).toBe("gpt-image-2");
    expect(DEFAULT_OPENAI_TTS_MODEL).toBe("gpt-4o-mini-tts");
    expect(DEFAULT_OPENAI_STT_MODEL).toBe("gpt-4o-transcribe");
    expect(OPENAI_TTS_VOICES).toContain("marin");
    expect(OPENAI_TTS_VOICES).toContain("cedar");
  });

  it("maps output formats to file extensions", () => {
    expect(extFromImageFormat("png")).toBe("png");
    expect(extFromImageFormat("jpeg")).toBe("jpg");
    expect(extFromImageFormat("webp")).toBe("webp");
    expect(extFromAudioFormat("mp3")).toBe("mp3");
    expect(extFromAudioFormat("pcm")).toBe("pcm");
  });

  it("validates image count range", () => {
    expect(parseNumImages("1")).toBe(1);
    expect(parseNumImages("10")).toBe(10);
    expect(() => parseNumImages("0")).toThrow(/1 to 10/);
    expect(() => parseNumImages("-1")).toThrow(/1 to 10/);
    expect(() => parseNumImages("999")).toThrow(/1 to 10/);
    expect(() => parseNumImages("abc")).toThrow(/1 to 10/);
  });
});

describe("OpenAI transcription request format", () => {
  it("maps CLI text output to API json for non-diarize GPT models", () => {
    expect(resolveTranscriptionRequestFormat("text", "gpt-4o-transcribe")).toBe("json");
    expect(resolveTranscriptionRequestFormat("text", "gpt-4o-mini-transcribe")).toBe("json");
  });

  it("allows diarized_json only with diarize model", () => {
    expect(resolveTranscriptionRequestFormat("diarized_json", "gpt-4o-transcribe-diarize")).toBe(
      "diarized_json",
    );
    expect(() => resolveTranscriptionRequestFormat("diarized_json", "gpt-4o-transcribe")).toThrow(
      /requires gpt-4o-transcribe-diarize/,
    );
  });

  it("validates known speaker pairing", () => {
    expect(() => validateKnownSpeakerPairing(["A"], [])).toThrow(/equal counts/);
    expect(() => validateKnownSpeakerPairing(["A", "B", "C", "D", "E"], ["1", "2"])).toThrow(
      /equal counts/,
    );
    expect(() =>
      validateKnownSpeakerPairing(["A", "B", "C", "D", "E"], ["1", "2", "3", "4", "5"]),
    ).toThrow(/up to 4/);
    expect(validateKnownSpeakerPairing(["A"], ["ref.wav"])).toBeUndefined();
  });
});
