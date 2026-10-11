import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import { extractJobIds } from "../../../../src/providers/heygen/commands/run.js";
import { templateBody } from "../../../../src/providers/heygen/commands/template.js";
import {
  buildAvatarVideoRequest,
  buildModelVideoRequest,
  buildSpeechRequest,
  buildVideoAgentRequest,
  checkCallback,
  classifyMediaRef,
  splitLanguages,
} from "../../../../src/providers/heygen/request-builders.js";

const URL_IN = { type: "url" as const, url: "https://x.test/a.png" };

describe("classifyMediaRef", () => {
  it("classifies https URLs, asset ids and paths", () => {
    expect(classifyMediaRef("https://x.test/a.mp4")).toEqual({
      kind: "url",
      url: "https://x.test/a.mp4",
    });
    expect(classifyMediaRef("asset:abc")).toEqual({ kind: "asset", assetId: "abc" });
    expect(classifyMediaRef("asset_id:abc")).toEqual({ kind: "asset", assetId: "abc" });
    expect(classifyMediaRef("./clip.mp4")).toEqual({ kind: "path", path: "./clip.mp4" });
  });

  it("rejects plain http and empty refs", () => {
    expect(() => classifyMediaRef("http://x.test/a.mp4")).toThrow(/https/);
    expect(() => classifyMediaRef("  ")).toThrow(ValidationError);
  });
});

describe("splitLanguages", () => {
  it("keeps commas inside parentheses and dedupes", () => {
    expect(splitLanguages("Spanish, Chinese (Cantonese, Traditional),French,Spanish")).toEqual([
      "Spanish",
      "Chinese (Cantonese, Traditional)",
      "French",
    ]);
  });

  it("rejects an empty list", () => {
    expect(() => splitLanguages(" , ")).toThrow(ValidationError);
  });
});

describe("checkCallback", () => {
  it("requires https", () => {
    expect(checkCallback(undefined)).toBeUndefined();
    expect(checkCallback("https://hook.test/x")).toBe("https://hook.test/x");
    expect(() => checkCallback("http://hook.test/x")).toThrow(ValidationError);
  });
});

describe("buildVideoAgentRequest", () => {
  it("builds a generate-mode body", () => {
    expect(
      buildVideoAgentRequest({
        prompt: "  A 30s product explainer ",
        avatarId: "look1",
        orientation: "portrait",
        files: [URL_IN],
        callbackUrl: "https://hook.test",
        callbackId: "c1",
      }),
    ).toEqual({
      prompt: "A 30s product explainer",
      mode: "generate",
      avatar_id: "look1",
      orientation: "portrait",
      files: [URL_IN],
      callback_url: "https://hook.test",
      callback_id: "c1",
    });
  });

  it("validates prompt length, orientation and file count", () => {
    expect(() => buildVideoAgentRequest({ prompt: "" })).toThrow(/Prompt/);
    expect(() => buildVideoAgentRequest({ prompt: "x".repeat(10_001) })).toThrow(/10000/);
    expect(() => buildVideoAgentRequest({ prompt: "x", orientation: "square" })).toThrow(
      /--orientation/,
    );
    expect(() =>
      buildVideoAgentRequest({ prompt: "x", files: Array.from({ length: 21 }, () => URL_IN) }),
    ).toThrow(/20 files/);
  });
});

describe("buildAvatarVideoRequest", () => {
  it("builds a scripted avatar body with voice settings, captions and engine", () => {
    expect(
      buildAvatarVideoRequest({
        avatarId: "look1",
        script: "Hello there",
        voiceId: "voice1",
        aspectRatio: "9:16",
        resolution: "1080p",
        burnCaptions: true,
        speed: "1.2",
        locale: "en-US",
        engine: "avatar_iv",
        expressiveness: "high",
        backgroundColor: "#ffffff",
      }),
    ).toEqual({
      type: "avatar",
      avatar_id: "look1",
      script: "Hello there",
      voice_id: "voice1",
      resolution: "1080p",
      aspect_ratio: "9:16",
      background: { type: "color", value: "#ffffff" },
      caption: { file_format: "srt", style: "default" },
      voice_settings: { speed: 1.2, locale: "en-US" },
      engine: { type: "avatar_iv" },
      expressiveness: "high",
    });
  });

  it("maps audio inputs to audio_url / audio_asset_id", () => {
    expect(
      buildAvatarVideoRequest({
        avatarId: "l",
        audio: { type: "url", url: "https://x.test/a.mp3" },
      }).audio_url,
    ).toBe("https://x.test/a.mp3");
    expect(
      buildAvatarVideoRequest({ avatarId: "l", audio: { type: "asset_id", asset_id: "as1" } })
        .audio_asset_id,
    ).toBe("as1");
  });

  it("enforces documented variant rules", () => {
    const audio = { type: "asset_id" as const, asset_id: "a" };
    expect(() => buildAvatarVideoRequest({ avatarId: "l" })).toThrow(/script/);
    expect(() => buildAvatarVideoRequest({ avatarId: "l", script: "x", audio })).toThrow(
      /not both/,
    );
    expect(() => buildAvatarVideoRequest({ avatarId: "l", audio, voiceId: "v" })).toThrow(
      /--voice/,
    );
    expect(() => buildAvatarVideoRequest({ avatarId: "l", audio, speed: 1 })).toThrow(
      /Voice settings/,
    );
    expect(() => buildAvatarVideoRequest({ avatarId: "l", script: "x".repeat(5001) })).toThrow(
      /5000/,
    );
    expect(() => buildAvatarVideoRequest({ avatarId: "l", script: "x", resolution: "4k" })).toThrow(
      /avatar_iii/,
    );
    expect(() =>
      buildAvatarVideoRequest({ avatarId: "l", script: "x", referenceLookId: "r" }),
    ).toThrow(/avatar_v/);
    expect(() =>
      buildAvatarVideoRequest({
        avatarId: "l",
        script: "x",
        engine: "avatar_iii",
        motionPrompt: "wave",
      }),
    ).toThrow(/motion-prompt/);
    expect(() =>
      buildAvatarVideoRequest({
        avatarId: "l",
        script: "x",
        engine: "avatar_v",
        expressiveness: "low",
      }),
    ).toThrow(/Avatar IV/);
    expect(() =>
      buildAvatarVideoRequest({
        avatarId: "l",
        script: "x",
        outputFormat: "webm",
        backgroundColor: "#000000",
      }),
    ).toThrow(/webm/);
    expect(() =>
      buildAvatarVideoRequest({ avatarId: "l", script: "x", backgroundColor: "red" }),
    ).toThrow(/hex/);
    expect(() => buildAvatarVideoRequest({ avatarId: "l", script: "x", speed: "3" })).toThrow(
      /--speed/,
    );
  });

  it("allows 4k with avatar_iii", () => {
    const body = buildAvatarVideoRequest({
      avatarId: "l",
      script: "x",
      resolution: "4k",
      engine: "avatar_iii",
    });
    expect(body.resolution).toBe("4k");
  });
});

describe("buildSpeechRequest", () => {
  it("builds and validates", () => {
    expect(
      buildSpeechRequest({ text: "<speak>Hi</speak>", voiceId: "v", ssml: true, speed: 2 }),
    ).toEqual({ text: "<speak>Hi</speak>", voice_id: "v", input_type: "ssml", speed: 2 });
    expect(() => buildSpeechRequest({ text: "", voiceId: "v" })).toThrow(/Text/);
    expect(() => buildSpeechRequest({ text: "hi", voiceId: "" })).toThrow(/--voice/);
    expect(() => buildSpeechRequest({ text: "hi", voiceId: "v", engine: "x" })).toThrow(/--engine/);
  });
});

describe("buildModelVideoRequest", () => {
  it("infers the mode from inputs", () => {
    expect(buildModelVideoRequest({ prompt: "a cat" }).mode).toBe("text_to_video");
    expect(buildModelVideoRequest({ prompt: "a cat", image: URL_IN }).mode).toBe("image_to_video");
    expect(buildModelVideoRequest({ prompt: "a cat", referenceImages: [URL_IN] }).mode).toBe(
      "reference_to_video",
    );
  });

  it("validates mode/reference combinations and ranges", () => {
    expect(() => buildModelVideoRequest({ prompt: "x", mode: "image_to_video" })).toThrow(
      /--image/,
    );
    expect(() => buildModelVideoRequest({ prompt: "x", mode: "reference_to_video" })).toThrow(
      /reference/,
    );
    expect(() =>
      buildModelVideoRequest({ prompt: "x", mode: "text_to_video", referenceImages: [URL_IN] }),
    ).toThrow(/reference_to_video/);
    expect(() => buildModelVideoRequest({ prompt: "x", aspectRatio: "adaptive" })).toThrow(
      /adaptive/,
    );
    expect(() =>
      buildModelVideoRequest({ prompt: "x", image: URL_IN, aspectRatio: "16:9" }),
    ).toThrow(/first frame/);
    expect(() => buildModelVideoRequest({ prompt: "x", duration: 4 })).toThrow(/--duration/);
    expect(() => buildModelVideoRequest({ prompt: "x", duration: 7.5 })).toThrow(/integer/);
    expect(() =>
      buildModelVideoRequest({
        prompt: "x",
        referenceImages: Array.from({ length: 10 }, () => URL_IN),
      }),
    ).toThrow(/reference images/);
    expect(() => buildModelVideoRequest({ prompt: "x", seed: -1 })).toThrow(/--seed/);
    // 9 images + 3 videos + 3 audio pass the per-type caps but exceed the combined 12.
    expect(() =>
      buildModelVideoRequest({
        prompt: "x",
        referenceImages: Array.from({ length: 9 }, () => URL_IN),
        referenceVideos: Array.from({ length: 3 }, () => URL_IN),
        referenceAudio: Array.from({ length: 3 }, () => URL_IN),
      }),
    ).toThrow(/12 reference files in total \(got 15\)/);
    expect(
      buildModelVideoRequest({
        prompt: "x",
        referenceImages: Array.from({ length: 9 }, () => URL_IN),
        referenceVideos: Array.from({ length: 3 }, () => URL_IN),
      }).mode,
    ).toBe("reference_to_video");
  });

  it("builds a full body", () => {
    expect(
      buildModelVideoRequest({
        prompt: "a cat",
        duration: "8",
        resolution: "1080p",
        aspectRatio: "16:9",
        promptEnhancement: "quality",
        seed: "42",
      }),
    ).toEqual({
      model: "heygen-video-1",
      mode: "text_to_video",
      prompt: "a cat",
      duration: 8,
      resolution: "1080p",
      aspect_ratio: "16:9",
      prompt_enhancement: "quality",
      seed: 42,
    });
  });
});

describe("extractJobIds", () => {
  it("reads single and multi-ID responses per operation", () => {
    expect(extractJobIds("video", { video_id: "v1" })).toEqual(["v1"]);
    expect(extractJobIds("video-agent", { session_id: "s1" })).toEqual(["s1"]);
    expect(extractJobIds("video-translation", { video_translation_ids: ["a", "b", 3] })).toEqual([
      "a",
      "b",
    ]);
    expect(extractJobIds("lipsync", { lipsync_id: "l1" })).toEqual(["l1"]);
    expect(extractJobIds("video", {})).toEqual([]);
    expect(extractJobIds("unknown", { video_id: "x" })).toEqual([]);
  });
});

describe("templateBody", () => {
  it("wraps a bare variables map and keeps a full body", () => {
    expect(templateBody({ name: { type: "text", properties: { content: "Duy" } } }, "T")).toEqual({
      variables: { name: { type: "text", properties: { content: "Duy" } } },
      title: "T",
    });
    expect(templateBody({ variables: {}, caption: true })).toEqual({
      variables: {},
      caption: true,
    });
    expect(() => templateBody({ variables: [] })).toThrow(/variables/);
  });
});
