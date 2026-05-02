import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetEnvLoader, loadEnv, redact, resolveKey } from "../../../src/core/env-loader.js";

describe("env-loader", () => {
  beforeEach(() => {
    _resetEnvLoader();
    // MULTIX_DISABLE_HOME_ENV is set globally in vitest.config.ts
  });

  afterEach(() => {
    _resetEnvLoader();
  });

  it("resolveKey returns process.env value", () => {
    process.env.TEST_MULTIX_KEY = "abc123";
    expect(resolveKey("TEST_MULTIX_KEY")).toBe("abc123");
    process.env.TEST_MULTIX_KEY = "";
  });

  it("resolveKey returns undefined for unset var", () => {
    process.env.NONEXISTENT_MULTIX_VAR = "";
    expect(resolveKey("NONEXISTENT_MULTIX_VAR")).toBeUndefined();
  });

  it("loadEnv is idempotent (safe to call multiple times)", () => {
    loadEnv();
    loadEnv(); // second call is a no-op
    // No throw = pass
  });

  it("process.env values survive loadEnv (override:false)", () => {
    process.env.GEMINI_API_KEY = "preset-value";
    loadEnv();
    expect(process.env.GEMINI_API_KEY).toBe("preset-value");
    process.env.GEMINI_API_KEY = undefined;
  });

  describe("redact", () => {
    it("masks middle of a long key", () => {
      const masked = redact("AIzaSyABCDEFGHIJKLMNOP");
      expect(masked).toMatch(/^AIzaSy\.\.\./);
      expect(masked).toMatch(/MNOP$/);
    });

    it("returns *** for very short keys", () => {
      expect(redact("abc")).toBe("***");
    });
  });
});
