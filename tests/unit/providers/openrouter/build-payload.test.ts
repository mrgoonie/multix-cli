import { describe, it, expect } from "vitest";
import {
  isOpenRouterModel,
  DEFAULT_OPENROUTER_MODEL,
} from "../../../../src/providers/openrouter/client.js";

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
