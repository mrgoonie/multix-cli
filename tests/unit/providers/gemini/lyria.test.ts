import { describe, expect, it } from "vitest";
import { ProviderError, ValidationError } from "../../../../src/core/errors.js";
import {
  buildMusicInteractionBody,
  parseMusicInteraction,
  validateMusicRequest,
} from "../../../../src/providers/gemini/lyria.js";
import { findLyriaMusicModel } from "../../../../src/providers/gemini/models.js";

const png = { mimeType: "image/png", data: "iVBORw0KGgo=" };

describe("buildMusicInteractionBody", () => {
  it("sends a plain text input and no response_format for MP3", () => {
    expect(
      buildMusicInteractionBody({ model: "lyria-3-clip-preview", prompt: " Lo-fi jazz " }),
    ).toEqual({ model: "lyria-3-clip-preview", input: "Lo-fi jazz" });
  });

  it("appends lyrics under a heading and asks for WAV on lyria-3.5", () => {
    expect(
      buildMusicInteractionBody({
        model: "models/lyria-3.5",
        prompt: "Indie pop",
        lyrics: "[Verse]\nHello\n",
        outputFormat: "wav",
      }),
    ).toEqual({
      model: "lyria-3.5",
      input: "Indie pop\n\nLyrics:\n[Verse]\nHello",
      response_format: { type: "audio", mime_type: "audio/wav" },
    });
  });

  it("sends images as content parts after the text", () => {
    const body = buildMusicInteractionBody({
      model: "lyria-3.5",
      prompt: "Ambient",
      images: [png],
    });
    expect(body.input).toEqual([
      { type: "text", text: "Ambient" },
      { type: "image", mime_type: "image/png", data: "iVBORw0KGgo=" },
    ]);
  });
});

describe("validateMusicRequest", () => {
  it("rejects WAV for the clip model instead of dropping it", () => {
    expect(() =>
      validateMusicRequest({ model: "lyria-3-clip-preview", prompt: "x", outputFormat: "wav" }),
    ).toThrow(/mp3 only.*lyria-3\.5/);
  });

  it("rejects unknown models, empty prompts and lyrics, too many or unsupported images", () => {
    expect(() => validateMusicRequest({ model: "lyria-realtime-exp", prompt: "x" })).toThrow(
      ValidationError,
    );
    expect(() => validateMusicRequest({ model: "lyria-3.5", prompt: "  " })).toThrow(/prompt/);
    expect(() => validateMusicRequest({ model: "lyria-3.5", prompt: "x", lyrics: " " })).toThrow(
      /Lyrics/,
    );
    expect(() =>
      validateMusicRequest({ model: "lyria-3.5", prompt: "x", images: Array(11).fill(png) }),
    ).toThrow(/at most 10/);
    expect(() =>
      validateMusicRequest({
        model: "lyria-3.5",
        prompt: "x",
        images: [{ mimeType: "image/gif", data: "R0lG" }],
      }),
    ).toThrow(/JPEG, PNG or WebP/);
  });

  it("knows both documented models", () => {
    expect(findLyriaMusicModel("lyria-3-clip-preview")?.outputFormats).toEqual(["mp3"]);
    expect(findLyriaMusicModel("lyria-3.5")?.outputFormats).toEqual(["mp3", "wav"]);
  });
});

describe("parseMusicInteraction", () => {
  it("reads the last audio block and joins the text blocks of model_output steps", () => {
    const result = parseMusicInteraction({
      id: "v1_abc",
      status: "completed",
      steps: [
        { type: "user_input", content: [{ type: "text", text: "prompt echo" }] },
        {
          type: "model_output",
          content: [
            { type: "text", text: "[Verse] la la" },
            { type: "audio", mime_type: "audio/mpeg", data: "AAAA" },
            { type: "text", text: "[Chorus] oh" },
            { type: "audio", mime_type: "audio/mpeg", data: "SUQz" },
          ],
        },
      ],
    });
    expect(result).toEqual({
      id: "v1_abc",
      status: "completed",
      mimeType: "audio/mpeg",
      audio: "SUQz",
      text: "[Verse] la la\n\n[Chorus] oh",
    });
  });

  it("falls back to output_audio/output_text", () => {
    expect(
      parseMusicInteraction({ output_audio: { data: "SUQz" }, output_text: "lyrics" }),
    ).toMatchObject({ audio: "SUQz", mimeType: "audio/mpeg", text: "lyrics" });
  });

  it("fails a failed, unfinished, empty or audio-less interaction", () => {
    expect(() =>
      parseMusicInteraction({ id: "v1_x", status: "failed", error: { message: "blocked" } }),
    ).toThrow("Lyria interaction failed (interaction v1_x): blocked");
    expect(() => parseMusicInteraction({ id: "v1_x", status: "in_progress" })).toThrow(
      /--interaction-id/,
    );
    expect(() => parseMusicInteraction(null)).toThrow(ProviderError);
    expect(() =>
      parseMusicInteraction({
        status: "completed",
        steps: [{ type: "model_output", content: [{ type: "text", text: "Prompt was blocked" }] }],
      }),
    ).toThrow("Lyria returned no audio: Prompt was blocked");
  });
});
