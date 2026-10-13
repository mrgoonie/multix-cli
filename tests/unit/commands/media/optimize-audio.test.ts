import { describe, expect, it } from "vitest";
import { buildAudioArgs } from "../../../../src/commands/media/optimize-audio.js";
import { ValidationError } from "../../../../src/core/errors.js";

const build = (output: string) =>
  buildAudioArgs({ input: "in.wav", output, bitrate: "64k", sampleRate: 16000 });

const codecOf = (args: string[]) => args[args.indexOf("-c:a") + 1];

describe("buildAudioArgs", () => {
  it.each([
    ["a.mp3", "libmp3lame"],
    ["a.m4a", "aac"],
    ["a.aac", "aac"],
    ["a.ogg", "libopus"],
    ["a.opus", "libopus"],
    ["a.wav", "pcm_s16le"],
    ["a.aiff", "pcm_s16be"],
    ["a.flac", "flac"],
    ["A.MP3", "libmp3lame"],
  ])("encodes %s with %s", (output, codec) => {
    expect(codecOf(build(output))).toBe(codec);
  });

  it("passes the bitrate to lossy codecs", () => {
    expect(build("a.mp3")).toEqual([
      "-i",
      "in.wav",
      "-y",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      "-ar",
      "16000",
      "-ac",
      "1",
      "a.mp3",
    ]);
  });

  it("omits the bitrate for lossless codecs", () => {
    expect(build("a.wav")).not.toContain("-b:a");
    expect(build("a.flac")).not.toContain("-b:a");
  });

  it.each(["a.mp4", "a.txt", "a"])("rejects %s before ffmpeg runs", (output) => {
    expect(() => build(output)).toThrow(ValidationError);
  });
});
