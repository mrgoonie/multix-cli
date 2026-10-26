import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../../src/core/logger.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function capture() {
  vi.stubEnv("NO_COLOR", "1");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return { log, err, warn };
}

describe("createLogger", () => {
  it("prints info, success, debug and header to stdout by default", () => {
    const { log, err } = capture();
    const logger = createLogger({ verbose: true });
    logger.info("i");
    logger.success("s");
    logger.debug("d");
    logger.header("h");
    expect(log).toHaveBeenCalledTimes(4);
    expect(err).not.toHaveBeenCalled();
  });

  it("with stderr: true keeps stdout empty for machine-readable output", () => {
    const { log, err, warn } = capture();
    const logger = createLogger({ verbose: true, stderr: true });
    logger.info("i");
    logger.success("s");
    logger.debug("d");
    logger.header("h");
    logger.warn("w");
    logger.error("e");
    expect(log).not.toHaveBeenCalled();
    expect(err.mock.calls.map((c) => c[0])).toEqual([
      "  i",
      "✓ s",
      "  [debug] d",
      expect.stringContaining("h"),
      "✗ e",
    ]);
    expect(warn).toHaveBeenCalledWith("⚠ w");
  });

  it("colours stderr lines by whether stderr, not stdout, is a terminal", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NO_COLOR", "");
    const saved = [process.stdout, process.stderr].map((s) =>
      Object.getOwnPropertyDescriptor(s, "isTTY"),
    );
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    try {
      createLogger({ verbose: false, stderr: true }).info("plain");
      createLogger({ verbose: false }).error("plain");
    } finally {
      [process.stdout, process.stderr].forEach((s, i) => {
        const d = saved[i];
        if (d) Object.defineProperty(s, "isTTY", d);
        else Reflect.deleteProperty(s, "isTTY");
      });
    }
    expect(err.mock.calls.map((c) => c[0])).toEqual(["  plain", "✗ plain"]);
  });

  it("redacts URL query strings in warnings and errors", () => {
    const { err, warn } = capture();
    const logger = createLogger({ verbose: false });
    logger.warn("Download failed for https://cdn.example.com/a.mp4?sig=SECRET1");
    logger.error("Provider said: cannot read https://cdn.example.com/b.wav?sig=SECRET2");
    expect(warn.mock.calls[0]?.[0]).toBe(
      "⚠ Download failed for https://cdn.example.com/a.mp4?[redacted]",
    );
    expect(err.mock.calls[0]?.[0]).toBe(
      "✗ Provider said: cannot read https://cdn.example.com/b.wav?[redacted]",
    );
  });
});
