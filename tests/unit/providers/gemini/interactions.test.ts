import { describe, expect, it } from "vitest";
import { unwrapGeminiFileRef } from "../../../../src/providers/gemini/client.js";
import {
  buildOmniInput,
  buildOmniInteractionPayload,
  extractOmniVideo,
  fileNameFromUri,
  selectGeminiDownloadUri,
  unwrapGeminiFile,
} from "../../../../src/providers/gemini/interactions.js";

describe("Gemini Omni interactions", () => {
  it("builds text, image, and uploaded-video input parts", () => {
    expect(
      buildOmniInput({
        prompt: "Make it cinematic",
        images: [{ data: "image-bytes", mimeType: "image/png" }],
        videoFileUri: "https://generativelanguage.googleapis.com/v1beta/files/input-video",
      }),
    ).toEqual([
      { type: "text", text: "Make it cinematic" },
      { type: "image", data: "image-bytes", mime_type: "image/png" },
      {
        type: "document",
        uri: "https://generativelanguage.googleapis.com/v1beta/files/input-video",
      },
    ]);
  });

  it("uses the required raw Interactions API payload and stateful continuation", () => {
    expect(
      buildOmniInteractionPayload({
        prompt: "Make a short clip",
        previousInteractionId: "interaction-previous",
      }),
    ).toEqual({
      model: "gemini-omni-flash-preview",
      input: [{ type: "text", text: "Make a short clip" }],
      response_format: { type: "video", delivery: "uri" },
      store: true,
      previous_interaction_id: "interaction-previous",
    });
  });

  it("extracts inline and URI video output and recognizes Files API names", () => {
    expect(
      extractOmniVideo({
        steps: [{ type: "model_output", content: [{ type: "video", data: "YWJj" }] }],
      }),
    ).toEqual({ kind: "inline", data: "YWJj", mimeType: "video/mp4" });
    expect(
      extractOmniVideo({
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "video",
                uri: "https://generativelanguage.googleapis.com/v1beta/files/generated-video",
                mime_type: "video/mp4",
              },
            ],
          },
        ],
      }),
    ).toEqual({
      kind: "uri",
      uri: "https://generativelanguage.googleapis.com/v1beta/files/generated-video",
      mimeType: "video/mp4",
    });
    expect(
      fileNameFromUri("https://generativelanguage.googleapis.com/v1beta/files/generated:download"),
    ).toBe("files/generated");
  });

  it("accepts the direct Files resource and uses its media download URI", () => {
    const file = {
      name: "files/generated-video",
      uri: "https://generativelanguage.googleapis.com/v1beta/files/generated-video",
      downloadUri:
        "https://generativelanguage.googleapis.com/v1beta/files/generated-video:download?alt=media",
      state: "ACTIVE" as const,
      mimeType: "video/mp4",
    };
    expect(unwrapGeminiFile(file)).toEqual(file);
    expect(unwrapGeminiFile({ file })).toEqual(file);
    expect(unwrapGeminiFileRef(file)).toEqual(file);
    expect(unwrapGeminiFileRef({ file })).toEqual(file);
    expect(selectGeminiDownloadUri(file, "https://fallback.invalid/video")).toBe(file.downloadUri);
  });
});
