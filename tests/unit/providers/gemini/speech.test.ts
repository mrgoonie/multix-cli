import { describe, expect, it } from "vitest";
import { extractInteractionAudio } from "../../../../src/providers/gemini/client.js";
import {
  buildInteractionsSpeechBody,
  extractWavData,
  parseSampleRate,
  wrapPcmInWav,
} from "../../../../src/providers/gemini/generators/speech.js";
import {
  GEMINI_TTS_MODELS,
  GEMINI_TTS_VOICES,
  TTS_MODEL_DEFAULT,
  isValidGeminiVoice,
  isVoiceAllowedForModel,
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

describe("Gemini 3.8 TTS (Interactions API)", () => {
  it("registers both 3.8 models and defaults to Flash-Lite", () => {
    expect(GEMINI_TTS_MODELS.has("gemini-3.8-flash-tts")).toBe(true);
    expect(GEMINI_TTS_MODELS.has("gemini-3.8-flash-lite-tts")).toBe(true);
    expect(TTS_MODEL_DEFAULT).toBe("gemini-3.8-flash-lite-tts");
  });

  it("accepts custom voice ids only for 3.8 models", () => {
    expect(isVoiceAllowedForModel("voice_abc123", "gemini-3.8-flash-tts")).toBe(true);
    expect(isVoiceAllowedForModel("voicekey_x-1", "gemini-3.8-flash-lite-tts")).toBe(true);
    expect(isVoiceAllowedForModel("voice_abc123", "gemini-3.1-flash-tts-preview")).toBe(false);
    expect(isVoiceAllowedForModel("Kore", "gemini-3.1-flash-tts-preview")).toBe(true);
  });

  it("builds a single-speaker body with style annotation", () => {
    const body = buildInteractionsSpeechBody({
      text: "Have a wonderful day!",
      model: "gemini-3.8-flash-tts",
      voice: "Kore",
      style: "cheerful and friendly",
    });
    expect(body).toEqual({
      model: "gemini-3.8-flash-tts",
      input: [
        {
          type: "user_input",
          content: [
            {
              type: "text",
              text: "Have a wonderful day!",
              annotations: [{ type: "speech_metadata", style: "cheerful and friendly" }],
            },
          ],
        },
      ],
      response_format: { type: "audio", mime_type: "audio/wav" },
      generation_config: { speech_config: [{ voice: "Kore" }] },
    });
  });

  it("builds a conversational multi-speaker body without annotations", () => {
    const body = buildInteractionsSpeechBody({
      text: "Joe: Hi\nJane: Hello",
      model: "gemini-3.8-flash-lite-tts",
      speakers: [
        { speaker: "Joe", voice: "Puck" },
        { speaker: "Jane", voice: "Kore" },
      ],
    });
    expect(body.generation_config).toEqual({
      speech_config: {
        mode: "conversational",
        speakers: [
          { speaker: "Joe", voice: "Puck" },
          { speaker: "Jane", voice: "Kore" },
        ],
      },
    });
    const content = (body.input as Array<{ content: Array<Record<string, unknown>> }>)[0]
      ?.content[0];
    expect(content?.annotations).toBeUndefined();
  });

  it("extracts the last audio block from a nested interaction", () => {
    const resp = {
      status: "completed",
      steps: [
        { content: [{ type: "text", text: "x" }] },
        { content: [{ type: "audio", data: "AAA=", mime_type: "audio/wav" }] },
        { content: [{ type: "audio", data: "QkI=", mime_type: "audio/wav" }] },
      ],
    };
    expect(extractInteractionAudio(resp)).toEqual({ mimeType: "audio/wav", data: "QkI=" });
    expect(extractInteractionAudio({ steps: [] })).toBeNull();
  });

  it("extracts raw PCM from a WAV buffer", () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    expect(extractWavData(wrapPcmInWav(pcm, 24_000, 1, 16))).toEqual(pcm);
  });
});
