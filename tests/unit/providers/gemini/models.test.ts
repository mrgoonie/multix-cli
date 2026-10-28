import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ANALYSIS_MODEL_DEFAULT,
  DOC_MODEL_DEFAULT,
  GEMINI_IMAGE_MODELS,
  IMAGE_MODEL_DEFAULT,
  TEXT_MODEL_DEFAULT,
  getDefaultModel,
} from "../../../../src/providers/gemini/models.js";

const ENV_KEYS = [
  "MULTIMODAL_MODEL",
  "GEMINI_MODEL",
  "IMAGE_GEN_MODEL",
  "GEMINI_IMAGE_GEN_MODEL",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv = new Map<EnvKey, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

describe("Gemini text-output model defaults", () => {
  it("defaults text-output tasks and document conversion to Gemini 3.6 Flash", () => {
    expect(TEXT_MODEL_DEFAULT).toBe("gemini-3.6-flash");
    expect(ANALYSIS_MODEL_DEFAULT).toBe(TEXT_MODEL_DEFAULT);
    expect(DOC_MODEL_DEFAULT).toBe(TEXT_MODEL_DEFAULT);
    expect(getDefaultModel("analyze")).toBe(TEXT_MODEL_DEFAULT);
    expect(getDefaultModel("transcribe")).toBe(TEXT_MODEL_DEFAULT);
    expect(getDefaultModel("extract")).toBe(TEXT_MODEL_DEFAULT);
  });

  it("keeps the multimodal override ahead of the generic Gemini override", () => {
    process.env[ENV_KEYS[0]] = "custom-multimodal";
    process.env[ENV_KEYS[1]] = "custom-gemini";

    expect(getDefaultModel("analyze")).toBe("custom-multimodal");
  });

  it("uses the generic Gemini override when the multimodal override is unset", () => {
    process.env[ENV_KEYS[1]] = "custom-gemini";

    expect(getDefaultModel("extract")).toBe("custom-gemini");
  });
});

describe("Gemini image model defaults", () => {
  it("defaults image generation to the GA Nano Banana 2 id, not a preview", () => {
    expect(IMAGE_MODEL_DEFAULT).toBe("gemini-3.1-flash-image");
    expect(getDefaultModel("generate")).toBe(IMAGE_MODEL_DEFAULT);
    expect(GEMINI_IMAGE_MODELS.has(IMAGE_MODEL_DEFAULT)).toBe(true);
  });

  it("no longer lists the Imagen 4 or shut-down preview ids", () => {
    for (const id of GEMINI_IMAGE_MODELS) expect(id).not.toMatch(/^imagen-/);
    expect(GEMINI_IMAGE_MODELS.has("gemini-2.5-flash-image-preview")).toBe(false);
  });

  it("keeps the image overrides", () => {
    process.env.GEMINI_IMAGE_GEN_MODEL = "custom-gemini-image";
    expect(getDefaultModel("generate")).toBe("custom-gemini-image");
    process.env.IMAGE_GEN_MODEL = "custom-image";
    expect(getDefaultModel("generate")).toBe("custom-image");
  });
});
