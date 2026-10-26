/**
 * Unit tests for elevenlabs models constants & extFromFormat helper.
 */

import { describe, expect, it } from "vitest";
import {
  ELEVENLABS_BASE_URL,
  ELEVENLABS_OUTPUT_FORMATS,
  ELEVENLABS_TTS_MODELS,
  ELEVENLABS_TTS_MODEL_CAPS,
  ELEVENLABS_TTS_OUTPUT_FORMATS,
  TASK_DEFAULTS,
  extFromFormat,
} from "../../../../src/providers/elevenlabs/models.js";

describe("elevenlabs models", () => {
  it("base URL points at v1", () => {
    expect(ELEVENLABS_BASE_URL).toBe("https://api.elevenlabs.io/v1");
  });

  it("includes the canonical TTS models", () => {
    expect(ELEVENLABS_TTS_MODELS).toContain("eleven_multilingual_v2");
    expect(ELEVENLABS_TTS_MODELS).toContain("eleven_flash_v2_5");
    expect(ELEVENLABS_TTS_MODELS).toContain("eleven_v3");
    expect(ELEVENLABS_TTS_MODELS).toContain("eleven_v4");
    expect(ELEVENLABS_TTS_MODELS).toContain("eleven_v4_turbo");
  });

  it("has a capability entry for every listed TTS model", () => {
    expect(Object.keys(ELEVENLABS_TTS_MODEL_CAPS).sort()).toEqual(
      [...ELEVENLABS_TTS_MODELS].sort(),
    );
  });

  it("TTS formats extend the shared list with wav, opus and alaw", () => {
    for (const f of ["mp3_44100_128", "wav_44100", "opus_48000_64", "alaw_8000", "pcm_48000"]) {
      expect(ELEVENLABS_TTS_OUTPUT_FORMATS).toContain(f);
    }
  });

  it("default tts format is a known mp3 format", () => {
    expect(ELEVENLABS_OUTPUT_FORMATS).toContain(TASK_DEFAULTS.ttsFormat);
    expect(TASK_DEFAULTS.ttsFormat.startsWith("mp3")).toBe(true);
  });

  it("extFromFormat maps codecs to file extensions", () => {
    expect(extFromFormat("mp3_44100_128")).toBe("mp3");
    expect(extFromFormat("pcm_24000")).toBe("pcm");
    expect(extFromFormat("ulaw_8000")).toBe("ulaw");
    expect(extFromFormat("alaw_8000")).toBe("alaw");
    expect(extFromFormat("wav_44100")).toBe("wav");
    expect(extFromFormat("opus_48000_64")).toBe("opus");
    expect(extFromFormat("nonsense")).toBe("mp3");
  });
});
