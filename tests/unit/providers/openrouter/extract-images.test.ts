import { describe, expect, it } from "vitest";
import {
  extractImagesFromResponse,
  formatNoImagesError,
} from "../../../../src/providers/openrouter/payload.js";

describe("extractImagesFromResponse", () => {
  it("extracts urls from canonical message.images shape", () => {
    const data = {
      model: "google/gemini-2.5-flash-image",
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "here you go",
            images: [
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
              { type: "image_url", image_url: { url: "https://cdn/x.png" } },
            ],
          },
        },
      ],
    };
    const out = extractImagesFromResponse(data);
    expect(out.urls).toEqual(["data:image/png;base64,AAAA", "https://cdn/x.png"]);
    expect(out.model).toBe("google/gemini-2.5-flash-image");
    expect(out.finishReason).toBe("stop");
    expect(out.textContent).toBe("here you go");
  });

  it("returns empty urls + diagnostic fields when no images present", () => {
    const data = {
      model: "openai/gpt-5.4-image-2",
      choices: [
        {
          finish_reason: "length",
          message: {
            role: "assistant",
            content: "I cannot generate images right now",
          },
        },
      ],
    };
    const out = extractImagesFromResponse(data);
    expect(out.urls).toEqual([]);
    expect(out.finishReason).toBe("length");
    expect(out.textContent).toBe("I cannot generate images right now");
  });

  it("falls back to message.content[] image_url parts", () => {
    const data = {
      choices: [
        {
          message: {
            content: [
              { type: "text", text: "voilà" },
              { type: "image_url", image_url: { url: "https://cdn/y.png" } },
            ],
          },
        },
      ],
    };
    const out = extractImagesFromResponse(data);
    expect(out.urls).toEqual(["https://cdn/y.png"]);
  });

  it("handles missing/empty data without throwing", () => {
    expect(extractImagesFromResponse(undefined).urls).toEqual([]);
    expect(extractImagesFromResponse(null).urls).toEqual([]);
    expect(extractImagesFromResponse({}).urls).toEqual([]);
    expect(extractImagesFromResponse({ choices: [] }).urls).toEqual([]);
    expect(extractImagesFromResponse({ choices: [{}] }).urls).toEqual([]);
  });

  it("ignores non-image content parts in fallback path", () => {
    const data = {
      choices: [{ message: { content: [{ type: "text", text: "hi" }] } }],
    };
    const out = extractImagesFromResponse(data);
    expect(out.urls).toEqual([]);
  });
});

describe("formatNoImagesError", () => {
  it("includes model id, finish reason, text content, and a hint", () => {
    const msg = formatNoImagesError("openai/gpt-5.4-image-2", {
      urls: [],
      finishReason: "length",
      textContent: "Sorry, cannot do that",
    });
    expect(msg).toContain("openai/gpt-5.4-image-2");
    expect(msg).toContain("length");
    expect(msg).toContain("Sorry, cannot do that");
    expect(msg.toLowerCase()).toContain("modalities");
  });

  it("works without text content / finish reason", () => {
    const msg = formatNoImagesError("x/y", { urls: [] });
    expect(msg).toContain("x/y");
    expect(msg).toContain("n/a");
  });

  it("truncates long text content", () => {
    const long = "a".repeat(500);
    const msg = formatNoImagesError("x/y", { urls: [], textContent: long });
    expect(msg).toContain("…");
    expect(msg.length).toBeLessThan(long.length + 200);
  });
});
