/**
 * createLogger: default stdout routing and the opt-in stderr mode that keeps
 * stdout free for a machine-readable result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../../src/core/logger.js";

let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("NO_COLOR", "1");
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function emitAll(logger: ReturnType<typeof createLogger>): void {
  logger.info("i");
  logger.success("s");
  logger.debug("d");
  logger.header("h");
  logger.warn("w");
  logger.error("e");
}

describe("createLogger", () => {
  it("writes info/success/debug/header to stdout by default", () => {
    emitAll(createLogger({ verbose: true }));
    expect(log).toHaveBeenCalledTimes(4);
    expect(log.mock.calls.map((c) => c[0])).toContain("  [debug] d");
    expect(warn).toHaveBeenCalledWith("⚠ w");
    expect(error).toHaveBeenCalledWith("✗ e");
  });

  it("with stderr: true writes nothing to stdout", () => {
    emitAll(createLogger({ verbose: true, stderr: true }));
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(["  i", "✓ s", "  [debug] d", "✗ e"]),
    );
    expect(warn).toHaveBeenCalledWith("⚠ w");
  });

  it("skips debug lines unless verbose", () => {
    createLogger({ verbose: false, stderr: true }).debug("d");
    expect(error).not.toHaveBeenCalled();
  });
});
