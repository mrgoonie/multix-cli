import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetEnvLoader,
  getLoadedEnvFiles,
  legacyClaudeEnvFiles,
  loadEnv,
  redact,
  resolveKey,
} from "../../../src/core/env-loader.js";

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
    // Assigning undefined would store the string "undefined"; delete instead.
    Reflect.deleteProperty(process.env, "GEMINI_API_KEY");
  });

  describe("legacy .claude layers", () => {
    let tmp: string;
    const VARS = ["MULTIX_LEGACY_CLAUDE_ENV", "LEGACY_A", "LEGACY_B", "LEGACY_C", "LEGACY_D"];

    const write = (rel: string, body: string) => {
      const file = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      return file;
    };

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-env-"));
      vi.spyOn(process, "cwd").mockReturnValue(tmp);
      for (const v of VARS) Reflect.deleteProperty(process.env, v);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      for (const v of VARS) Reflect.deleteProperty(process.env, v);
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("orders skill-specific files before skills/.env and .claude/.env, project before home", () => {
      const files = legacyClaudeEnvFiles("/proj", "/home/u").map((f) =>
        f.split(path.sep).join("/"),
      );
      expect(files.map((f) => f.replace(/^[A-Za-z]:/, ""))).toEqual([
        "/proj/.claude/skills/ai-multimodal/.env",
        "/proj/.claude/skills/ak-ai-multimodal/.env",
        "/proj/.claude/skills/.env",
        "/proj/.claude/.env",
        "/home/u/.claude/skills/ai-multimodal/.env",
        "/home/u/.claude/skills/ak-ai-multimodal/.env",
        "/home/u/.claude/skills/.env",
        "/home/u/.claude/.env",
      ]);
    });

    it("ignores legacy files unless MULTIX_LEGACY_CLAUDE_ENV is set", () => {
      write(".claude/.env", "LEGACY_A=from-claude\n");
      loadEnv();
      expect(process.env.LEGACY_A).toBeUndefined();
      expect(getLoadedEnvFiles()).toEqual([]);
    });

    it("loads legacy layers after cwd/.env with the most specific file winning", () => {
      const cwdEnv = write(".env", "MULTIX_LEGACY_CLAUDE_ENV=1\nLEGACY_A=from-cwd\n");
      const skill = write(".claude/skills/ai-multimodal/.env", "LEGACY_A=skill\nLEGACY_B=skill\n");
      const skills = write(".claude/skills/.env", "LEGACY_B=skills\nLEGACY_C=skills\n");
      const claude = write(".claude/.env", "LEGACY_C=claude\nLEGACY_D=claude\n");
      loadEnv();
      expect(process.env.LEGACY_A).toBe("from-cwd");
      expect(process.env.LEGACY_B).toBe("skill");
      expect(process.env.LEGACY_C).toBe("skills");
      expect(process.env.LEGACY_D).toBe("claude");
      expect(getLoadedEnvFiles()).toEqual([cwdEnv, skill, skills, claude]);
    });

    it("never overrides process.env", () => {
      process.env.MULTIX_LEGACY_CLAUDE_ENV = "true";
      process.env.LEGACY_A = "shell";
      write(".claude/.env", "LEGACY_A=file\n");
      loadEnv();
      expect(process.env.LEGACY_A).toBe("shell");
    });
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
