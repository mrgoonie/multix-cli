import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetEnvLoader,
  getLoadedEnvFiles,
  isLegacyAllowedName,
  legacyClaudeEnvEnabled,
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
    const VARS = [
      "MULTIX_LEGACY_CLAUDE_ENV",
      "LEGACY_A_API_KEY",
      "LEGACY_B_API_KEY",
      "LEGACY_C_API_KEY",
      "LEGACY_D_API_KEY",
      "LEGACY_BASE_URL",
    ];

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

    it("ignores legacy files unless MULTIX_LEGACY_CLAUDE_ENV is truthy", () => {
      write(".claude/.env", "LEGACY_A_API_KEY=from-claude\n");
      process.env.MULTIX_LEGACY_CLAUDE_ENV = "0";
      loadEnv();
      expect(process.env.LEGACY_A_API_KEY).toBeUndefined();
      expect(getLoadedEnvFiles()).toEqual([]);
    });

    it("parses the flag like the loader does", () => {
      for (const v of ["1", "true", "TRUE", " yes ", "on"]) {
        expect(legacyClaudeEnvEnabled({ MULTIX_LEGACY_CLAUDE_ENV: v })).toBe(true);
      }
      for (const v of [undefined, "", "0", "false", "off"]) {
        expect(legacyClaudeEnvEnabled({ MULTIX_LEGACY_CLAUDE_ENV: v })).toBe(false);
      }
    });

    it("loads legacy layers after cwd/.env with the most specific file winning", () => {
      const cwdEnv = write(".env", "MULTIX_LEGACY_CLAUDE_ENV=1\nLEGACY_A_API_KEY=from-cwd\n");
      const skill = write(
        ".claude/skills/ai-multimodal/.env",
        "LEGACY_A_API_KEY=skill\nLEGACY_B_API_KEY=skill\n",
      );
      const akSkill = write(".claude/skills/ak-ai-multimodal/.env", "LEGACY_B_API_KEY=ak-skill\n");
      const skills = write(
        ".claude/skills/.env",
        "LEGACY_B_API_KEY=skills\nLEGACY_C_API_KEY=skills\n",
      );
      const claude = write(".claude/.env", "LEGACY_C_API_KEY=claude\nLEGACY_D_API_KEY=claude\n");
      loadEnv();
      expect(process.env.LEGACY_A_API_KEY).toBe("from-cwd");
      expect(process.env.LEGACY_B_API_KEY).toBe("skill");
      expect(process.env.LEGACY_C_API_KEY).toBe("skills");
      expect(process.env.LEGACY_D_API_KEY).toBe("claude");
      expect(getLoadedEnvFiles()).toEqual([cwdEnv, skill, akSkill, skills, claude]);
    });

    it("takes only credential-shaped names from legacy files", () => {
      process.env.MULTIX_LEGACY_CLAUDE_ENV = "1";
      write(".claude/.env", "LEGACY_A_API_KEY=ok\nLEGACY_BASE_URL=https://evil.example\n");
      loadEnv();
      expect(process.env.LEGACY_A_API_KEY).toBe("ok");
      expect(process.env.LEGACY_BASE_URL).toBeUndefined();
      expect(isLegacyAllowedName("GEMINI_API_KEY_2")).toBe(true);
      expect(isLegacyAllowedName("FAL_KEY")).toBe(true);
      expect(isLegacyAllowedName("CLOUDFLARE_ACCOUNT_ID")).toBe(true);
      expect(isLegacyAllowedName("REPLICATE_API_TOKEN")).toBe(true);
      expect(isLegacyAllowedName("FAL_BASE_URL")).toBe(false);
      expect(isLegacyAllowedName("HTTPS_PROXY")).toBe(false);
      expect(isLegacyAllowedName("NODE_OPTIONS")).toBe(false);
      expect(isLegacyAllowedName("MULTIX_OUTPUT_DIR")).toBe(false);
    });

    it("skips directories named .env and never overrides process.env", () => {
      process.env.MULTIX_LEGACY_CLAUDE_ENV = "true";
      process.env.LEGACY_A_API_KEY = "shell";
      fs.mkdirSync(path.join(tmp, ".claude", "skills", ".env"), { recursive: true });
      const claude = write(".claude/.env", "LEGACY_A_API_KEY=file\n");
      loadEnv();
      expect(process.env.LEGACY_A_API_KEY).toBe("shell");
      expect(getLoadedEnvFiles()).toEqual([claude]);
    });

    it("does not list home layers twice when cwd is the home directory", () => {
      const files = legacyClaudeEnvFiles("/same", "/same");
      expect(files).toHaveLength(4);
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
