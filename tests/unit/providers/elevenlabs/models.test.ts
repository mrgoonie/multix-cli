/**
 * Unit tests for elevenlabs models constants & extFromFormat helper.
 */

import { describe, expect, it } from "vitest";
import {
  ELEVENLABS_BASE_URL,
  ELEVENLABS_OUTPUT_FORMATS,
  ELEVENLABS_TTS_MODELS,
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
  });

  it("default tts format is a known mp3 format", () => {
    expect(ELEVENLABS_OUTPUT_FORMATS).toContain(TASK_DEFAULTS.ttsFormat);
    expect(TASK_DEFAULTS.ttsFormat.startsWith("mp3")).toBe(true);
  });

  it("extFromFormat maps codecs to file extensions", () => {
    expect(extFromFormat("mp3_44100_128")).toBe("mp3");
    expect(extFromFormat("pcm_24000")).toBe("pcm");
    expect(extFromFormat("ulaw_8000")).toBe("ulaw");
    expect(extFromFormat("nonsense")).toBe("mp3");
  });
});
