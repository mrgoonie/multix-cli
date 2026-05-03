import { describe, expect, it } from "vitest";
import {
  parseSampleRate,
  wrapPcmInWav,
} from "../../../../src/providers/gemini/generators/speech.js";
import {
  GEMINI_TTS_MODELS,
  GEMINI_TTS_VOICES,
  TTS_MODEL_DEFAULT,
  isValidGeminiVoice,
} from "../../../../src/providers/gemini/voices.js";

describe("Gemini TTS voices/models registry", () => {
  it("contains exactly 30 prebuilt voices", () => {
    expect(GEMINI_TTS_VOICES).toHaveLength(30);
  });

  it("validates known voices and rejects unknown", () => {
    expect(isValidGeminiVoice("Kore")).toBe(true);
    expect(isValidGeminiVoice("Puck")).toBe(true);
    expect(isValidGeminiVoice("not-a-voice")).toBe(false);
  });

  it("default model is in the model set", () => {
    expect(GEMINI_TTS_MODELS.has(TTS_MODEL_DEFAULT)).toBe(true);
  });
});

describe("parseSampleRate", () => {
  it("parses rate from audio/L16;rate=24000", () => {
    expect(parseSampleRate("audio/L16;rate=24000")).toBe(24_000);
  });

  it("returns null when rate missing", () => {
    expect(parseSampleRate("audio/L16")).toBeNull();
  });
});

describe("wrapPcmInWav", () => {
  const pcm = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]); // 4 samples (s16le mono)
  const wav = wrapPcmInWav(pcm, 24_000, 1, 16);

  it("prepends a 44-byte header", () => {
    expect(wav.length).toBe(44 + pcm.length);
  });

  it("starts with RIFF/WAVE/fmt /data tags", () => {
    expect(wav.slice(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.slice(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.slice(12, 16).toString("ascii")).toBe("fmt ");
    expect(wav.slice(36, 40).toString("ascii")).toBe("data");
  });

  it("encodes correct sample rate, channels and bits", () => {
    expect(wav.readUInt16LE(20)).toBe(1); // PCM format
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24_000); // sample rate
    expect(wav.readUInt32LE(28)).toBe(24_000 * 1 * 2); // byte rate
    expect(wav.readUInt16LE(32)).toBe(2); // block align
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(pcm.length); // data size
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length); // RIFF chunk size
  });
});
