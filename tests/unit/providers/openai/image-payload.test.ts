import { describe, expect, it } from "vitest";
import {
  buildImageEditForm,
  buildImageGenerationBody,
} from "../../../../src/providers/openai/openai-image.js";

describe("OpenAI image payloads", () => {
  it("builds generation body with defaults and output format", () => {
    expect(
      buildImageGenerationBody({
        prompt: "a cat",
        model: undefined,
        size: undefined,
        quality: undefined,
        outputFormat: "webp",
      }),
    ).toMatchObject({
      model: "gpt-image-2",
      prompt: "a cat",
      size: "1024x1024",
      quality: "medium",
      output_format: "webp",
    });
  });

  it("builds multipart edit form with repeated image[] fields", async () => {
    const refs = [
      { filename: "a.png", bytes: Buffer.from("one"), mime: "image/png" },
      { filename: "b.jpg", bytes: Buffer.from("two"), mime: "image/jpeg" },
    ];
    const form = await buildImageEditForm({
      prompt: "make it cyberpunk",
      refs,
      model: "gpt-image-2",
      size: "auto",
      quality: "high",
      outputFormat: "png",
    });

    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("prompt")).toBe("make it cyberpunk");
    expect(form.get("size")).toBe("auto");
    expect(form.get("quality")).toBe("high");
    expect(form.get("output_format")).toBe("png");
    expect(form.getAll("image[]")).toHaveLength(2);
  });
});
