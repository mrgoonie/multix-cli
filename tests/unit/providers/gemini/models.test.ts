import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ANALYSIS_MODEL_DEFAULT,
  DOC_MODEL_DEFAULT,
  GEMINI_IMAGE_MODELS,
  IMAGE_MODEL_DEFAULT,
  TEXT_MODEL_DEFAULT,
  TTS_MODEL_DEFAULT,
  VIDEO_MODEL_DEFAULT,
  getDefaultModel,
} from "../../../../src/providers/gemini/models.js";
import { GEMINI_TTS_MODELS } from "../../../../src/providers/gemini/voices.js";

const ENV_KEYS = [
  "MULTIMODAL_MODEL",
  "GEMINI_MODEL",
  "IMAGE_GEN_MODEL",
  "GEMINI_IMAGE_GEN_MODEL",
  "VIDEO_GEN_MODEL",
  "GEMINI_TTS_MODEL",
  "TTS_MODEL",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

const originalEnv = new Map<EnvKey, string | undefined>();

function clearGeminiModelEnv(): void {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
}

function restoreGeminiModelEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  originalEnv.clear();
}

describe("Gemini text-output model defaults", () => {
  beforeEach(clearGeminiModelEnv);
  afterEach(restoreGeminiModelEnv);

  it("defaults text-output tasks to Gemini 3.6 Flash", () => {
    expect(TEXT_MODEL_DEFAULT).toBe("gemini-3.6-flash");
    expect(ANALYSIS_MODEL_DEFAULT).toBe(TEXT_MODEL_DEFAULT);
    expect(DOC_MODEL_DEFAULT).toBe(TEXT_MODEL_DEFAULT);
    expect(getDefaultModel("analyze")).toBe(TEXT_MODEL_DEFAULT);
    expect(getDefaultModel("transcribe")).toBe(TEXT_MODEL_DEFAULT);
    expect(getDefaultModel("extract")).toBe(TEXT_MODEL_DEFAULT);
  });

  it("keeps MULTIMODAL_MODEL ahead of GEMINI_MODEL for text-output tasks", () => {
    process.env.MULTIMODAL_MODEL = "custom-multimodal";
    process.env.GEMINI_MODEL = "custom-gemini";

    expect(getDefaultModel("analyze")).toBe("custom-multimodal");
    expect(getDefaultModel("transcribe")).toBe("custom-multimodal");
    expect(getDefaultModel("extract")).toBe("custom-multimodal");
  });

  it("uses GEMINI_MODEL when MULTIMODAL_MODEL is unset", () => {
    process.env.GEMINI_MODEL = "custom-gemini";

    expect(getDefaultModel("analyze")).toBe("custom-gemini");
    expect(getDefaultModel("transcribe")).toBe("custom-gemini");
    expect(getDefaultModel("extract")).toBe("custom-gemini");
  });

  it("keeps media env vars from changing text-output tasks", () => {
    process.env.IMAGE_GEN_MODEL = "custom-image";
    process.env.GEMINI_IMAGE_GEN_MODEL = "custom-gemini-image";
    process.env.VIDEO_GEN_MODEL = "custom-video";
    process.env.GEMINI_TTS_MODEL = "custom-tts";
    process.env.TTS_MODEL = "custom-tts-fallback";

    expect(getDefaultModel("analyze")).toBe(TEXT_MODEL_DEFAULT);
    expect(getDefaultModel("transcribe")).toBe(TEXT_MODEL_DEFAULT);
    expect(getDefaultModel("extract")).toBe(TEXT_MODEL_DEFAULT);
  });

  it("keeps text env vars from changing media generation tasks", () => {
    process.env.MULTIMODAL_MODEL = "custom-multimodal";
    process.env.GEMINI_MODEL = "custom-gemini";

    expect(getDefaultModel("generate")).toBe(IMAGE_MODEL_DEFAULT);
    expect(getDefaultModel("generate-video")).toBe(VIDEO_MODEL_DEFAULT);
    expect(getDefaultModel("generate-speech")).toBe(TTS_MODEL_DEFAULT);
  });

  it("keeps media-specific env overrides scoped to media tasks", () => {
    process.env.IMAGE_GEN_MODEL = "custom-image";
    process.env.GEMINI_IMAGE_GEN_MODEL = "custom-gemini-image";
    process.env.VIDEO_GEN_MODEL = "veo-custom";
    process.env.GEMINI_TTS_MODEL = "custom-tts";
    process.env.TTS_MODEL = "custom-tts-fallback";

    expect(getDefaultModel("generate")).toBe("custom-image");
    expect(getDefaultModel("generate-video")).toBe("veo-custom");
    expect(getDefaultModel("generate-speech")).toBe("custom-tts");
  });

  it("keeps media generation model registries separate from Gemini 3.6 Flash", () => {
    expect(IMAGE_MODEL_DEFAULT).not.toBe(TEXT_MODEL_DEFAULT);
    expect(VIDEO_MODEL_DEFAULT.startsWith("veo-")).toBe(true);
    expect(GEMINI_IMAGE_MODELS.has(TEXT_MODEL_DEFAULT)).toBe(false);
    expect(GEMINI_TTS_MODELS.has(TEXT_MODEL_DEFAULT)).toBe(false);
  });
});
