import { beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.hoisted(() => vi.fn());
vi.mock("execa", () => ({ execa: execaMock }));

import { ffmpegErrorMessage, runFfmpeg } from "../../../../src/commands/media/ffmpeg-runner.js";
import { ProviderError } from "../../../../src/core/errors.js";

describe("ffmpegErrorMessage", () => {
  it("keeps a short log whole", () => {
    expect(ffmpegErrorMessage("  Unknown encoder 'x'\n")).toBe(
      "ffmpeg failed: Unknown encoder 'x'",
    );
  });

  it("keeps a log of exactly the limit whole", () => {
    const log = "x".repeat(1000);
    expect(ffmpegErrorMessage(log)).toBe(`ffmpeg failed: ${log}`);
  });

  it("keeps the tail of a long log from a line boundary, where ffmpeg reports the cause", () => {
    const log = `${"configuration: --enable-x\n".repeat(100)}Conversion failed!`;
    const message = ffmpegErrorMessage(log);
    expect(message.startsWith("ffmpeg failed: …\nconfiguration: --enable-x\n")).toBe(true);
    expect(message.endsWith("Conversion failed!")).toBe(true);
    expect(message.length).toBeLessThanOrEqual("ffmpeg failed: …\n".length + 1000);
  });

  it("falls back when stderr is empty", () => {
    expect(ffmpegErrorMessage("  ", "Command was killed with SIGKILL")).toBe(
      "ffmpeg failed: Command was killed with SIGKILL",
    );
  });
});

describe("runFfmpeg", () => {
  beforeEach(() => execaMock.mockReset());

  it("passes -hide_banner before the caller's arguments", async () => {
    execaMock.mockResolvedValue({ stderr: "" });
    await runFfmpeg(["-i", "in.wav", "out.mp3"]);
    expect(execaMock).toHaveBeenCalledWith("ffmpeg", ["-hide_banner", "-i", "in.wav", "out.mp3"], {
      reject: true,
      all: true,
    });
  });

  it("throws a ProviderError carrying ffmpeg's stderr, or err.all without it", async () => {
    execaMock.mockRejectedValueOnce({ stderr: "Invalid size 'abc'" });
    await expect(runFfmpeg(["-i", "a"])).rejects.toThrow("ffmpeg failed: Invalid size 'abc'");

    execaMock.mockRejectedValueOnce({ all: "Conversion failed!" });
    const err = await runFfmpeg(["-i", "a"]).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("ffmpeg failed: Conversion failed!");
  });
});
