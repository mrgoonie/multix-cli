import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENROUTER_MODEL,
  isOpenRouterModel,
} from "../../../../src/providers/openrouter/client.js";
import {
  buildI2IPayload,
  resolveModalities,
} from "../../../../src/providers/openrouter/payload.js";

describe("isOpenRouterModel", () => {
  it("returns true for model with slash", () => {
    expect(isOpenRouterModel("google/gemini-3.1-flash-image-preview")).toBe(true);
  });

  it("returns true for non-google openrouter model", () => {
    expect(isOpenRouterModel("anthropic/claude-3-haiku")).toBe(true);
  });

  it("returns false for gemini direct model", () => {
    expect(isOpenRouterModel("gemini-2.5-flash")).toBe(false);
  });

  it("returns false for minimax model", () => {
    expect(isOpenRouterModel("image-01")).toBe(false);
  });

  it("returns false for http URL", () => {
    expect(isOpenRouterModel("https://api.example.com/v1/model")).toBe(false);
  });
});

describe("DEFAULT_OPENROUTER_MODEL", () => {
  it("is the expected google gemini model", () => {
    expect(DEFAULT_OPENROUTER_MODEL).toBe("google/gemini-3.1-flash-image-preview");
  });
});

describe("resolveModalities", () => {
  it("returns image+text for OpenAI gpt-image models (regression for gpt-5.4-image-2)", () => {
    expect(resolveModalities("openai/gpt-5.4-image-2")).toEqual(["image", "text"]);
  });

  it("returns image+text for Gemini models", () => {
    expect(resolveModalities("google/gemini-2.5-flash-image")).toEqual(["image", "text"]);
    expect(resolveModalities("google/gemini-3.1-flash-image-preview")).toEqual(["image", "text"]);
  });

  it("returns image+text for Recraft models", () => {
    expect(resolveModalities("recraft/recraft-v3")).toEqual(["image", "text"]);
  });

  it("returns image-only for Flux models", () => {
    expect(resolveModalities("black-forest-labs/flux-kontext-pro")).toEqual(["image"]);
    expect(resolveModalities("black-forest-labs/flux.2-pro")).toEqual(["image"]);
    expect(resolveModalities("black-forest-labs/flux.2-max")).toEqual(["image"]);
    expect(resolveModalities("black-forest-labs/flux.2-flex")).toEqual(["image"]);
  });

  it("returns image-only for Seedream models (verified via live 404)", () => {
    expect(resolveModalities("bytedance-seed/seedream-4.5")).toEqual(["image"]);
  });

  it("returns image+text for non-seedream bytedance-seed chat models", () => {
    expect(resolveModalities("bytedance-seed/seed-1.6")).toEqual(["image", "text"]);
    expect(resolveModalities("bytedance-seed/seed-2.0-lite")).toEqual(["image", "text"]);
  });

  it("returns image-only for Sourceful models", () => {
    expect(resolveModalities("sourceful/anything")).toEqual(["image"]);
  });

  it("is case-insensitive on prefix match", () => {
    expect(resolveModalities("Black-Forest-Labs/FLUX-pro")).toEqual(["image"]);
  });
});

describe("buildI2IPayload", () => {
  const baseRefs = ["data:image/png;base64,AAAA", "https://example.com/img.png"];

  it("builds canonical payload with model + modalities + content order", () => {
    const p = buildI2IPayload({
      prompt: "make it watercolor",
      model: "google/gemini-2.5-flash-image",
      refs: baseRefs,
      fallbackModels: [],
    });
    expect(p.model).toBe("google/gemini-2.5-flash-image");
    expect(p.models).toBeUndefined();
    expect(p.modalities).toEqual(["image", "text"]);
    expect(p.image_config).toBeUndefined();
    const messages = p.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages[0]?.role).toBe("user");
    const content = messages[0]?.content ?? [];
    // refs first, text last
    expect(content[0]?.type).toBe("image_url");
    expect(content[1]?.type).toBe("image_url");
    expect(content[2]?.type).toBe("text");
    expect((content[2] as { text?: string }).text).toBe("make it watercolor");
  });

  it("emits image_config.strength when provided", () => {
    const p = buildI2IPayload({
      prompt: "x",
      model: "recraft/recraft-v3",
      refs: ["url"],
      strength: 0.7,
      fallbackModels: [],
    });
    expect(p.image_config).toEqual({ strength: 0.7 });
  });

  it("omits image_config when strength is undefined", () => {
    const p = buildI2IPayload({
      prompt: "x",
      model: "openai/gpt-5.4-image-2",
      refs: ["url"],
      fallbackModels: [],
    });
    expect(p.image_config).toBeUndefined();
  });

  it("uses models[] when fallbacks present", () => {
    const p = buildI2IPayload({
      prompt: "x",
      model: "openai/gpt-5.4-image-2",
      refs: ["url"],
      fallbackModels: ["google/gemini-2.5-flash-image", "black-forest-labs/flux-kontext-pro"],
    });
    expect(p.model).toBeUndefined();
    expect(p.models).toEqual([
      "openai/gpt-5.4-image-2",
      "google/gemini-2.5-flash-image",
      "black-forest-labs/flux-kontext-pro",
    ]);
  });

  it("uses model (not models[]) when fallback list empty", () => {
    const p = buildI2IPayload({
      prompt: "x",
      model: "openai/gpt-5.4-image-2",
      refs: ["url"],
      fallbackModels: [],
    });
    expect(p.model).toBe("openai/gpt-5.4-image-2");
    expect(p.models).toBeUndefined();
  });

  it("respects modalities for image-only families even in i2i", () => {
    const p = buildI2IPayload({
      prompt: "x",
      model: "black-forest-labs/flux-kontext-pro",
      refs: ["url"],
      fallbackModels: [],
    });
    expect(p.modalities).toEqual(["image"]);
  });
});
