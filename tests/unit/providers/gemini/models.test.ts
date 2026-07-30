import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ANALYSIS_MODEL_DEFAULT,
  DOC_MODEL_DEFAULT,
  TEXT_MODEL_DEFAULT,
  getDefaultModel,
} from "../../../../src/providers/gemini/models.js";

const ENV_KEYS = ["MULTIMODAL_MODEL", "GEMINI_MODEL"] as const;
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
