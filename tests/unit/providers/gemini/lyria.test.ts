import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import { resolveMusicFormat } from "../../../../src/providers/gemini/commands/generate-music.js";
import {
  buildLyriaRequest,
  extractLyriaAudio,
  extractLyriaText,
  lyriaCost,
  lyriaFailureMessage,
  sniffAudioFormat,
  summarizeLyriaInteraction,
  validateLyriaRequest,
} from "../../../../src/providers/gemini/lyria.js";

const MP3 = Buffer.from("ID3\u0003\u0000\u0000rest-of-mp3");
const WAV = Buffer.concat([Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVEfmt "), Buffer.alloc(8)]);

function completed(data: string, text?: string) {
  return {
    id: "v1_song",
    status: "completed",
    model: "lyria-3.5",
    steps: [
      { type: "user_input", content: [{ type: "text", text: "the prompt" }] },
      {
        type: "model_output",
        content: [...(text ? [{ type: "text", text }] : []), { type: "audio", data }],
      },
    ],
    usage: { total_input_tokens: 8, total_output_tokens: 291 },
  };
}

describe("buildLyriaRequest", () => {
  it("stores and backgrounds a text-only clip request, with no response_format", () => {
    expect(buildLyriaRequest({ model: "lyria-3-clip-preview", prompt: " lo-fi piano " })).toEqual({
      model: "lyria-3-clip-preview",
      input: "lo-fi piano",
      store: true,
      background: true,
    });
  });

  it("asks for WAV with mime_type (type alone returns MP3) and appends lyrics", () => {
    const body = buildLyriaRequest({
      model: "models/lyria-3.5",
      prompt: "indie pop",
      lyrics: "[Verse]\nla la\n",
      format: "wav",
    });
    expect(body.model).toBe("lyria-3.5");
    expect(body.input).toBe("indie pop\n\nLyrics:\n[Verse]\nla la");
    expect(body.response_format).toEqual({ type: "audio", mime_type: "audio/wav" });
  });

  it("sends the text part before inline images", () => {
    const body = buildLyriaRequest({
      model: "lyria-3.5",
      prompt: "ambient",
      images: [{ data: "AAAA", mime_type: "image/png" }],
    });
    expect(body.input).toEqual([
      { type: "text", text: "ambient" },
      { type: "image", data: "AAAA", mime_type: "image/png" },
    ]);
    expect(body.response_format).toBeUndefined();
  });
});

describe("validateLyriaRequest", () => {
  it("rejects unknown models, including the RealTime model", () => {
    expect(() => validateLyriaRequest({ model: "lyria-realtime-exp" })).toThrow(/different API/);
    expect(() => validateLyriaRequest({ model: "gemini-3.6-flash" })).toThrow(ValidationError);
  });

  it("rejects WAV and images on the clip model, and more than 10 images", () => {
    expect(() => validateLyriaRequest({ model: "lyria-3-clip-preview", format: "wav" })).toThrow(
      /mp3/,
    );
    expect(() => validateLyriaRequest({ model: "lyria-3-clip-preview", imageCount: 1 })).toThrow(
      /does not take reference images/,
    );
    expect(() => validateLyriaRequest({ model: "lyria-3.5", imageCount: 11 })).toThrow(
      /at most 10/,
    );
    expect(validateLyriaRequest({ model: "lyria-3.5", format: "wav", imageCount: 10 }).id).toBe(
      "lyria-3.5",
    );
  });

  it("rejects an empty prompt", () => {
    expect(() => validateLyriaRequest({ model: "lyria-3.5", prompt: "  " })).toThrow(/empty/);
  });
});

describe("resolveMusicFormat", () => {
  it("infers the format from --output and refuses a conflicting pair", () => {
    expect(resolveMusicFormat(undefined, "song.WAV")).toBe("wav");
    expect(resolveMusicFormat(undefined, "song.ogg")).toBeUndefined();
    expect(resolveMusicFormat("MP3", "song.mp3")).toBe("mp3");
    expect(() => resolveMusicFormat("wav", "song.mp3")).toThrow(/does not match/);
    expect(() => resolveMusicFormat("flac", undefined)).toThrow(/mp3 or wav/);
  });
});

describe("reading a completed interaction", () => {
  it("takes the audio and lyrics from model_output only", () => {
    const it = completed(MP3.toString("base64"), "[Verse] la la");
    expect(extractLyriaAudio(it)?.data).toBe(MP3.toString("base64"));
    expect(extractLyriaText(it)).toBe("[Verse] la la");
    expect(extractLyriaAudio({ steps: [{ type: "user_input", content: [] }] })).toBeNull();
    expect(extractLyriaAudio(null)).toBeNull();
  });

  it("sniffs MP3 (ID3 or frame sync) and WAV, and nothing else", () => {
    expect(sniffAudioFormat(MP3)).toBe("mp3");
    expect(sniffAudioFormat(Uint8Array.from([0xff, 0xfb, 0x90]))).toBe("mp3");
    expect(sniffAudioFormat(WAV)).toBe("wav");
    expect(sniffAudioFormat(Buffer.from("<html>"))).toBeNull();
    expect(sniffAudioFormat(new Uint8Array())).toBeNull();
  });

  it("summarizes without audio bytes and prices only a completed song", () => {
    const data = MP3.toString("base64");
    const summary = summarizeLyriaInteraction(completed(data));
    expect(JSON.stringify(summary)).not.toContain(data);
    expect(summary).toMatchObject({
      interaction_id: "v1_song",
      status: "completed",
      audio: { bytes: MP3.length },
      cost_estimate: { usd: 0.08 },
    });
    expect(
      summarizeLyriaInteraction({ id: "x", status: "in_progress", model: "lyria-3.5" }),
    ).not.toHaveProperty("cost_estimate");
    expect(lyriaCost("lyria-3-clip-preview")?.usd).toBe(0.04);
    expect(lyriaCost("unknown")).toBeNull();
  });

  it("explains a failed interaction", () => {
    expect(
      lyriaFailureMessage({ id: "v1_x", status: "failed", error: { message: "blocked" } }),
    ).toBe("Gemini Lyria interaction v1_x failed: blocked");
  });
});
