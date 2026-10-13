import { describe, expect, it } from "vitest";
import { ffmpegErrorMessage } from "../../../../src/commands/media/ffmpeg-runner.js";

describe("ffmpegErrorMessage", () => {
  it("keeps a short log whole", () => {
    expect(ffmpegErrorMessage("  Unknown encoder 'x'\n")).toBe(
      "ffmpeg failed: Unknown encoder 'x'",
    );
  });

  it("keeps the tail of a long log, where ffmpeg reports the cause", () => {
    const log = `${"configuration: --enable-x ".repeat(100)}\nConversion failed!`;
    const message = ffmpegErrorMessage(log);
    expect(message.endsWith("Conversion failed!")).toBe(true);
    expect(message).toContain("ffmpeg failed: …");
    expect(message.length).toBeLessThanOrEqual("ffmpeg failed: …".length + 1000);
  });
});
