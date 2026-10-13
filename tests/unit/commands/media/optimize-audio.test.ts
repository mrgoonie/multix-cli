import { describe, expect, it } from "vitest";
import { buildAudioArgs } from "../../../../src/commands/media/optimize-audio.js";
import { ValidationError } from "../../../../src/core/errors.js";

const base = { input: "in.wav", bitrate: "64k", sampleRate: 16000 };

function codecFor(output: string): string | undefined {
  const args = buildAudioArgs({ ...base, output });
  return args[args.indexOf("-c:a") + 1];
}

describe("buildAudioArgs", () => {
  it.each([
    ["a.mp3", "libmp3lame"],
    ["a.m4a", "aac"],
    ["a.aac", "aac"],
    ["a.opus", "libopus"],
    ["a.ogg", "libopus"],
    ["a.wav", "pcm_s16le"],
    ["a.aiff", "pcm_s16be"],
    ["a.flac", "flac"],
    ["A.MP3", "libmp3lame"],
  ])("encodes %s with %s", (output, codec) => {
    expect(codecFor(output)).toBe(codec);
  });

  it("builds the full lossy argument list with bitrate, sample rate and mono", () => {
    expect(buildAudioArgs({ ...base, output: "out/a.mp3" })).toEqual([
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
      "out/a.mp3",
    ]);
  });

  it("omits -b:a for lossless and PCM codecs", () => {
    for (const output of ["a.wav", "a.flac", "a.aiff"]) {
      expect(buildAudioArgs({ ...base, output })).not.toContain("-b:a");
    }
  });

  it("rejects an unsupported output extension with a ValidationError", () => {
    expect(() => buildAudioArgs({ ...base, output: "a.wma" })).toThrow(ValidationError);
    expect(() => buildAudioArgs({ ...base, output: "a.wma" })).toThrow(/\.wma/);
  });

  it("rejects an output without an extension", () => {
    expect(() => buildAudioArgs({ ...base, output: "audio" })).toThrow(/\(none\)/);
  });
});
