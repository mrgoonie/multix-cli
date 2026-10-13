import { describe, expect, it } from "vitest";
import { AUDIO_EXTS } from "../../../../src/commands/media/detect-type.js";
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
    ["a.mp4", "aac"],
    ["a.mka", "aac"],
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
      "-vn",
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

  it("omits the bitrate for lossless codecs but keeps 16 kHz mono", () => {
    expect(build("a.wav")).toEqual([
      "-i",
      "in.wav",
      "-y",
      "-vn",
      "-c:a",
      "pcm_s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      "a.wav",
    ]);
    expect(build("a.flac")).not.toContain("-b:a");
  });

  // batch writes each file under its input name, so every audio input must be a valid output
  it.each([...AUDIO_EXTS])("accepts the batch input extension %s as an output", (ext) => {
    expect(() => build(`a${ext}`)).not.toThrow();
  });

  it.each(["a.mov", "a.txt", "a"])("rejects %s with a ValidationError", (output) => {
    expect(() => build(output)).toThrow(ValidationError);
  });
});
