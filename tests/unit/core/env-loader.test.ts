import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALLOW_PROJECT_BASE_URL_ENV,
  _resetEnvLoader,
  envFileOrigin,
  envNameKey,
  getLoadedEnvFiles,
  isLegacyAllowedName,
  legacyClaudeEnvEnabled,
  legacyClaudeEnvFiles,
  loadEnv,
  projectBaseUrlAllowed,
  redact,
  resolveBaseUrl,
  resolveKey,
  resolveTrustedSetting,
} from "../../../src/core/env-loader.js";
import { ConfigError } from "../../../src/core/errors.js";
import { requireCloudflareConfig } from "../../../src/providers/cloudflare/models.js";

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

  describe("resolveBaseUrl and resolveTrustedSetting", () => {
    const DEFAULT = "https://api.example-default.com/v1";
    const NAME = "TESTPROV_BASE_URL";
    const KEY = "TESTPROV_API_KEY";
    const CF = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_GATEWAY_ID", "CLOUDFLARE_API_TOKEN"];
    const VARS = [
      NAME,
      KEY,
      ...CF,
      ALLOW_PROJECT_BASE_URL_ENV,
      "MULTIX_DISABLE_HOME_ENV",
      "MULTIX_LEGACY_CLAUDE_ENV",
    ];
    const saved: Record<string, string | undefined> = {};
    let tmp: string;
    let home: string;
    let warn: ReturnType<typeof vi.spyOn>;

    const writeProject = (body: string) => fs.writeFileSync(path.join(tmp, ".env"), body);
    const writeUser = (body: string) => {
      fs.mkdirSync(path.join(home, ".multix"), { recursive: true });
      fs.writeFileSync(path.join(home, ".multix", ".env"), body);
    };
    const warnings = () => warn.mock.calls.map((c) => String(c[0]));

    beforeEach(() => {
      for (const v of VARS) saved[v] = process.env[v];
      for (const v of VARS) Reflect.deleteProperty(process.env, v);
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-proj-"));
      home = fs.mkdtempSync(path.join(os.tmpdir(), "multix-home-"));
      vi.spyOn(process, "cwd").mockReturnValue(tmp);
      vi.spyOn(os, "homedir").mockReturnValue(home);
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
      for (const v of VARS) {
        if (saved[v] === undefined) Reflect.deleteProperty(process.env, v);
        else process.env[v] = saved[v];
      }
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    });

    it("returns the default silently when nothing is set", () => {
      loadEnv();
      expect(resolveBaseUrl(NAME, DEFAULT)).toBe(DEFAULT);
      expect(warn).not.toHaveBeenCalled();
    });

    const refusal = (): Error => {
      try {
        resolveBaseUrl(NAME, DEFAULT);
      } catch (err) {
        return err as Error;
      }
      throw new Error("expected resolveBaseUrl to throw");
    };

    it("refuses a project-only .env value, naming the variable and file, not the value", () => {
      writeProject(`${NAME}=https://evil.example.net/steal\n${KEY}=sk-secret-value\n`);
      loadEnv();
      expect(envFileOrigin(NAME)?.source).toBe("project");
      const err = refusal();
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).toContain(NAME);
      expect(err.message).toContain(path.join(tmp, ".env"));
      expect(err.message).toContain(`${ALLOW_PROJECT_BASE_URL_ENV}=1 multix`);
      expect(err.message).toContain("every directory");
      expect(err.message).not.toContain("evil.example.net");
      expect(err.message).not.toContain("sk-secret-value");
      expect(warn).not.toHaveBeenCalled();
    });

    it("accepts a project value equal to the default", () => {
      writeProject(`${NAME}=${DEFAULT}/\n`);
      loadEnv();
      expect(resolveBaseUrl(NAME, DEFAULT)).toBe(DEFAULT);
      expect(warn).not.toHaveBeenCalled();
    });

    it("honours a shell value and warns once with the hostname only", () => {
      process.env[NAME] = "https://proxy.example.org/v1/path?token=abc";
      process.env[KEY] = "sk-secret-value";
      writeProject(`${NAME}=https://evil.example.net\n`);
      loadEnv();
      expect(resolveBaseUrl(NAME, DEFAULT)).toBe("https://proxy.example.org/v1/path?token=abc");
      resolveBaseUrl(NAME, DEFAULT);
      expect(warn).toHaveBeenCalledTimes(1);
      const [message] = warnings();
      expect(message).toContain("TESTPROV");
      expect(message).toContain("proxy.example.org");
      expect(message).not.toContain("/v1/path");
      expect(message).not.toContain("token=abc");
      expect(message).not.toContain("sk-secret-value");
    });

    it("honours a user-level value", () => {
      writeUser(`${NAME}=https://user-proxy.example.org\n`);
      loadEnv();
      expect(envFileOrigin(NAME)?.source).toBe("user");
      expect(resolveBaseUrl(NAME, DEFAULT)).toBe("https://user-proxy.example.org");
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain("user-proxy.example.org");
    });

    it("falls back to the user-level value when the project .env shadows it", () => {
      writeProject(`${NAME}=https://evil.example.net\n`);
      writeUser(`${NAME}=https://user-proxy.example.org\n`);
      loadEnv();
      expect(resolveBaseUrl(NAME, DEFAULT)).toBe("https://user-proxy.example.org");
      expect(warnings()).toHaveLength(2);
      expect(warnings()[0]).toContain(`${ALLOW_PROJECT_BASE_URL_ENV}=1 multix`);
      expect(warnings().join("\n")).not.toContain("evil.example.net");
    });

    it("does not let an empty project value hide the user-level value", () => {
      writeProject(`${NAME}=\n`);
      writeUser(`${NAME}=https://user-proxy.example.org\n`);
      loadEnv();
      expect(resolveBaseUrl(NAME, DEFAULT)).toBe("https://user-proxy.example.org");
      expect(warnings()).toHaveLength(2);
      expect(warnings()[0]).toContain(`Ignoring ${NAME}`);
    });

    it("treats an empty project value with no user value as unset", () => {
      writeProject(`${NAME}=  \n`);
      loadEnv();
      expect(resolveBaseUrl(NAME, DEFAULT)).toBe(DEFAULT);
      expect(warn).not.toHaveBeenCalled();
    });

    it("shows only the hostname for a URL with userinfo and a port", () => {
      process.env[NAME] = "https://alice:pa55word@proxy.example.org:8443/x?sig=abc";
      loadEnv();
      resolveBaseUrl(NAME, DEFAULT);
      const [message] = warnings();
      expect(message).toContain("proxy.example.org");
      for (const leak of ["alice", "pa55word", "8443", "/x", "sig=abc"]) {
        expect(message).not.toContain(leak);
      }
    });

    it("requires https except for http:// to localhost, 127.0.0.1 or [::1]", () => {
      for (const ok of ["http://localhost:8787", "http://127.0.0.1:9000/v1", "http://[::1]:1"]) {
        _resetEnvLoader();
        process.env[NAME] = ok;
        expect(resolveBaseUrl(NAME, DEFAULT)).toBe(ok);
      }
      for (const bad of [
        "http://proxy.example.org",
        "http://localhost.evil.test",
        "ftp://proxy.example.org",
        "proxy.example.org",
      ]) {
        _resetEnvLoader();
        process.env[NAME] = bad;
        const err = refusal();
        expect(err).toBeInstanceOf(ConfigError);
        expect(err.message).toMatch(/must (use|be an absolute) https:\/\//);
      }
    });

    it("honours a project value when the opt-in is set in the shell or user env", () => {
      writeProject(`${NAME}=https://local-mock.example.net\n`);
      process.env[ALLOW_PROJECT_BASE_URL_ENV] = "1";
      loadEnv();
      expect(projectBaseUrlAllowed()).toBe(true);
      expect(resolveBaseUrl(NAME, DEFAULT)).toBe("https://local-mock.example.net");
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain("local-mock.example.net");

      _resetEnvLoader();
      Reflect.deleteProperty(process.env, ALLOW_PROJECT_BASE_URL_ENV);
      Reflect.deleteProperty(process.env, NAME);
      writeUser(`${ALLOW_PROJECT_BASE_URL_ENV}=true\n`);
      loadEnv();
      expect(resolveBaseUrl(NAME, DEFAULT)).toBe("https://local-mock.example.net");
    });

    it("does not accept the opt-in from the project .env itself", () => {
      writeProject(`${ALLOW_PROJECT_BASE_URL_ENV}=1\n${NAME}=https://evil.example.net\n`);
      loadEnv();
      expect(projectBaseUrlAllowed()).toBe(false);
      expect(refusal()).toBeInstanceOf(ConfigError);
    });

    it.runIf(process.platform === "win32")(
      "Windows: a lower-case project name is still project-sourced",
      () => {
        writeProject(`${NAME.toLowerCase()}=https://evil.example.net\n`);
        loadEnv();
        expect(process.env[NAME]).toBe("https://evil.example.net");
        expect(envFileOrigin(NAME)?.source).toBe("project");
        expect(refusal()).toBeInstanceOf(ConfigError);
      },
    );

    it.runIf(process.platform === "win32")(
      "Windows: a lower-case opt-in in the project .env is not honoured",
      () => {
        writeProject(
          `${ALLOW_PROJECT_BASE_URL_ENV.toLowerCase()}=1\n${NAME}=https://evil.example.net\n`,
        );
        loadEnv();
        expect(process.env[ALLOW_PROJECT_BASE_URL_ENV]).toBe("1");
        expect(projectBaseUrlAllowed()).toBe(false);
        expect(refusal()).toBeInstanceOf(ConfigError);
      },
    );

    it.runIf(process.platform === "win32")(
      "Windows: a mixed-case user-level value is found as the fallback",
      () => {
        writeProject(`${NAME}=https://evil.example.net\n`);
        writeUser("Testprov_Base_Url=https://user-proxy.example.org\n");
        loadEnv();
        expect(resolveBaseUrl(NAME, DEFAULT)).toBe("https://user-proxy.example.org");
      },
    );

    it("refuses Cloudflare account and gateway IDs from a project .env unless opted in", () => {
      process.env.CLOUDFLARE_API_TOKEN = "cf-token-from-shell";
      writeProject(
        "CLOUDFLARE_ACCOUNT_ID=attacker-account\nCLOUDFLARE_AI_GATEWAY_ID=attacker-gw\n",
      );
      loadEnv();
      expect(() => requireCloudflareConfig()).toThrow(
        /CLOUDFLARE_ACCOUNT_ID is set in project env/,
      );
      expect(() => resolveTrustedSetting("CLOUDFLARE_AI_GATEWAY_ID")).toThrow(ConfigError);

      process.env[ALLOW_PROJECT_BASE_URL_ENV] = "1";
      expect(requireCloudflareConfig()).toMatchObject({
        accountId: "attacker-account",
        gatewayId: "attacker-gw",
      });
    });

    it("uses the user-level Cloudflare IDs over project ones", () => {
      process.env.CLOUDFLARE_API_TOKEN = "cf-token-from-shell";
      writeProject("CLOUDFLARE_ACCOUNT_ID=attacker-account\n");
      writeUser("CLOUDFLARE_ACCOUNT_ID=my-account\nCLOUDFLARE_AI_GATEWAY_ID=my-gw\n");
      loadEnv();
      expect(requireCloudflareConfig()).toMatchObject({
        accountId: "my-account",
        gatewayId: "my-gw",
      });
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain("Ignoring CLOUDFLARE_ACCOUNT_ID");
    });

    it("treats legacy .claude files under cwd as project files, under home as trusted", () => {
      process.env.MULTIX_LEGACY_CLAUDE_ENV = "1";
      fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".claude", ".env"),
        `CLOUDFLARE_AI_GATEWAY_ID=attacker-gw\n${ALLOW_PROJECT_BASE_URL_ENV}=1\n`,
      );
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(home, ".claude", ".env"), "CLOUDFLARE_ACCOUNT_ID=my-account\n");
      loadEnv();
      expect(process.env[ALLOW_PROJECT_BASE_URL_ENV]).toBeUndefined();
      expect(envFileOrigin("CLOUDFLARE_AI_GATEWAY_ID")?.source).toBe("project");
      expect(() => resolveTrustedSetting("CLOUDFLARE_AI_GATEWAY_ID")).toThrow(ConfigError);
      expect(envFileOrigin("CLOUDFLARE_ACCOUNT_ID")?.source).toBe("legacy");
      expect(resolveTrustedSetting("CLOUDFLARE_ACCOUNT_ID")).toBe("my-account");
    });

    it("envNameKey upper-cases names on win32 only", () => {
      expect(envNameKey("heygen_base_url", "win32")).toBe("HEYGEN_BASE_URL");
      expect(envNameKey("Multix_Allow_Project_Base_Url", "win32")).toBe(ALLOW_PROJECT_BASE_URL_ENV);
      expect(envNameKey("heygen_base_url", "linux")).toBe("heygen_base_url");
      expect(envNameKey("HEYGEN_BASE_URL", "darwin")).toBe("HEYGEN_BASE_URL");
    });

    it("does not warn when the override equals the default", () => {
      process.env[NAME] = `${DEFAULT}/`;
      loadEnv();
      expect(resolveBaseUrl(NAME, DEFAULT)).toBe(DEFAULT);
      expect(warn).not.toHaveBeenCalled();
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
