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
  resolveProviderBaseUrl,
  resolveTrustedSetting,
} from "../../../src/core/env-loader.js";
import { ConfigError } from "../../../src/core/errors.js";
import { requireAtlasKey } from "../../../src/providers/atlascloud/commands/env.js";
import { ATLAS_ROUTING } from "../../../src/providers/atlascloud/models.js";
import { requireBytePlusKey } from "../../../src/providers/byteplus/client.js";
import { BYTEPLUS_ROUTING } from "../../../src/providers/byteplus/models.js";
import {
  requireCloudflareConfig,
  requireCloudflareVideoConfig,
} from "../../../src/providers/cloudflare/models.js";
import { falBaseUrl, requireFalKey } from "../../../src/providers/fal/client.js";
import { FAL_ROUTING } from "../../../src/providers/fal/models.js";
import { HEYGEN_ROUTING } from "../../../src/providers/heygen/models.js";
import { requireHeygenKey } from "../../../src/providers/heygen/node-helpers.js";
import { requireLeonardoKey } from "../../../src/providers/leonardo/client.js";
import { LEONARDO_ROUTING } from "../../../src/providers/leonardo/models.js";
import { REPLICATE_ROUTING } from "../../../src/providers/replicate/models.js";
import { requireReplicateToken } from "../../../src/providers/replicate/node-client.js";

/** Existing tests use made-up names; the project allowlist has its own tests below. */
const ALLOW_ALL = { isProjectEnvName: () => true };

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
    loadEnv(ALLOW_ALL);
    loadEnv(ALLOW_ALL); // second call is a no-op
    // No throw = pass
  });

  it("process.env values survive loadEnv (override:false)", () => {
    process.env.GEMINI_API_KEY = "preset-value";
    loadEnv(ALLOW_ALL);
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
      loadEnv(ALLOW_ALL);
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
      loadEnv(ALLOW_ALL);
      expect(process.env.LEGACY_A_API_KEY).toBe("from-cwd");
      expect(process.env.LEGACY_B_API_KEY).toBe("skill");
      expect(process.env.LEGACY_C_API_KEY).toBe("skills");
      expect(process.env.LEGACY_D_API_KEY).toBe("claude");
      expect(getLoadedEnvFiles()).toEqual([cwdEnv, skill, akSkill, skills, claude]);
    });

    it("takes only credential-shaped names from legacy files", () => {
      process.env.MULTIX_LEGACY_CLAUDE_ENV = "1";
      write(".claude/.env", "LEGACY_A_API_KEY=ok\nLEGACY_BASE_URL=https://evil.example\n");
      loadEnv(ALLOW_ALL);
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
      loadEnv(ALLOW_ALL);
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
    const CF = [
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_AI_GATEWAY_ID",
      "CLOUDFLARE_API_TOKEN",
      "REPLICATE_API_TOKEN",
    ];
    const CF_CREDS = ["CLOUDFLARE_API_TOKEN"];
    const ROUTINGS = [
      ATLAS_ROUTING,
      BYTEPLUS_ROUTING,
      FAL_ROUTING,
      HEYGEN_ROUTING,
      LEONARDO_ROUTING,
      REPLICATE_ROUTING,
    ];
    const VARS = [
      NAME,
      KEY,
      ...CF,
      ...ROUTINGS.flatMap((r) => [r.name, ...r.keyEnvs]),
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
      // Most cases model the attack: the key comes from the shell, not the project.
      process.env[KEY] = "sk-shell-key";
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
      loadEnv(ALLOW_ALL);
      expect(resolveBaseUrl(NAME, DEFAULT, [KEY])).toBe(DEFAULT);
      expect(warn).not.toHaveBeenCalled();
    });

    const refusal = (): Error => {
      try {
        resolveBaseUrl(NAME, DEFAULT, [KEY]);
      } catch (err) {
        return err as Error;
      }
      throw new Error("expected resolveBaseUrl to throw");
    };

    it("refuses a project-only .env value, naming the variable and file, not the value", () => {
      writeProject(`${NAME}=https://evil.example.net/steal\n${KEY}=sk-secret-value\n`);
      loadEnv(ALLOW_ALL);
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
      loadEnv(ALLOW_ALL);
      expect(resolveBaseUrl(NAME, DEFAULT, [KEY])).toBe(DEFAULT);
      expect(warn).not.toHaveBeenCalled();
    });

    it("honours a shell value and warns once with the hostname only", () => {
      process.env[NAME] = "https://proxy.example.org/v1/path?token=abc";
      process.env[KEY] = "sk-secret-value";
      writeProject(`${NAME}=https://evil.example.net\n`);
      loadEnv(ALLOW_ALL);
      expect(resolveBaseUrl(NAME, DEFAULT, [KEY])).toBe(
        "https://proxy.example.org/v1/path?token=abc",
      );
      resolveBaseUrl(NAME, DEFAULT, [KEY]);
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
      loadEnv(ALLOW_ALL);
      expect(envFileOrigin(NAME)?.source).toBe("user");
      expect(resolveBaseUrl(NAME, DEFAULT, [KEY])).toBe("https://user-proxy.example.org");
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain("user-proxy.example.org");
    });

    it("falls back to the user-level value when the project .env shadows it", () => {
      writeProject(`${NAME}=https://evil.example.net\n`);
      writeUser(`${NAME}=https://user-proxy.example.org\n`);
      loadEnv(ALLOW_ALL);
      expect(resolveBaseUrl(NAME, DEFAULT, [KEY])).toBe("https://user-proxy.example.org");
      expect(warnings()).toHaveLength(2);
      expect(warnings()[0]).toContain(`${ALLOW_PROJECT_BASE_URL_ENV}=1 multix`);
      expect(warnings().join("\n")).not.toContain("evil.example.net");
    });

    it("does not let an empty project value hide the user-level value", () => {
      writeProject(`${NAME}=\n`);
      writeUser(`${NAME}=https://user-proxy.example.org\n`);
      loadEnv(ALLOW_ALL);
      expect(resolveBaseUrl(NAME, DEFAULT, [KEY])).toBe("https://user-proxy.example.org");
      expect(warnings()).toHaveLength(2);
      expect(warnings()[0]).toContain(`Ignoring ${NAME}`);
    });

    it("treats an empty project value with no user value as unset", () => {
      writeProject(`${NAME}=  \n`);
      loadEnv(ALLOW_ALL);
      expect(resolveBaseUrl(NAME, DEFAULT, [KEY])).toBe(DEFAULT);
      expect(warn).not.toHaveBeenCalled();
    });

    it("shows only the hostname for a URL with userinfo and a port", () => {
      process.env[NAME] = "https://alice:pa55word@proxy.example.org:8443/x?sig=abc";
      loadEnv(ALLOW_ALL);
      resolveBaseUrl(NAME, DEFAULT, [KEY]);
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
        expect(resolveBaseUrl(NAME, DEFAULT, [KEY])).toBe(ok);
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
      loadEnv(ALLOW_ALL);
      expect(projectBaseUrlAllowed()).toBe(true);
      expect(resolveBaseUrl(NAME, DEFAULT, [KEY])).toBe("https://local-mock.example.net");
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain("local-mock.example.net");

      _resetEnvLoader();
      Reflect.deleteProperty(process.env, ALLOW_PROJECT_BASE_URL_ENV);
      Reflect.deleteProperty(process.env, NAME);
      writeUser(`${ALLOW_PROJECT_BASE_URL_ENV}=true\n`);
      loadEnv(ALLOW_ALL);
      expect(resolveBaseUrl(NAME, DEFAULT, [KEY])).toBe("https://local-mock.example.net");
    });

    it("does not accept the opt-in from the project .env itself", () => {
      writeProject(`${ALLOW_PROJECT_BASE_URL_ENV}=1\n${NAME}=https://evil.example.net\n`);
      loadEnv(ALLOW_ALL);
      expect(projectBaseUrlAllowed()).toBe(false);
      expect(refusal()).toBeInstanceOf(ConfigError);
    });

    it.runIf(process.platform === "win32")(
      "Windows: a lower-case project name is still project-sourced",
      () => {
        writeProject(`${NAME.toLowerCase()}=https://evil.example.net\n`);
        loadEnv(ALLOW_ALL);
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
        loadEnv(ALLOW_ALL);
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
        loadEnv(ALLOW_ALL);
        expect(resolveBaseUrl(NAME, DEFAULT, [KEY])).toBe("https://user-proxy.example.org");
      },
    );

    it("refuses Cloudflare account and gateway IDs from a project .env unless opted in", () => {
      process.env.CLOUDFLARE_API_TOKEN = "cf-token-from-shell";
      writeProject(
        "CLOUDFLARE_ACCOUNT_ID=attacker-account\nCLOUDFLARE_AI_GATEWAY_ID=attacker-gw\n",
      );
      loadEnv(ALLOW_ALL);
      expect(() => requireCloudflareConfig()).toThrow(
        /CLOUDFLARE_ACCOUNT_ID is set in project env/,
      );
      expect(() => resolveTrustedSetting("CLOUDFLARE_AI_GATEWAY_ID", CF_CREDS)).toThrow(
        ConfigError,
      );

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
      loadEnv(ALLOW_ALL);
      expect(requireCloudflareConfig()).toMatchObject({
        accountId: "my-account",
        gatewayId: "my-gw",
      });
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain("Ignoring CLOUDFLARE_ACCOUNT_ID");
    });

    it("treats legacy .claude files under cwd as project files, under home as trusted", () => {
      process.env.MULTIX_LEGACY_CLAUDE_ENV = "1";
      process.env.CLOUDFLARE_API_TOKEN = "cf-token-from-shell";
      fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".claude", ".env"),
        `CLOUDFLARE_AI_GATEWAY_ID=attacker-gw\n${ALLOW_PROJECT_BASE_URL_ENV}=1\n`,
      );
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(home, ".claude", ".env"), "CLOUDFLARE_ACCOUNT_ID=my-account\n");
      loadEnv(ALLOW_ALL);
      expect(process.env[ALLOW_PROJECT_BASE_URL_ENV]).toBeUndefined();
      expect(envFileOrigin("CLOUDFLARE_AI_GATEWAY_ID")?.source).toBe("project");
      expect(() => resolveTrustedSetting("CLOUDFLARE_AI_GATEWAY_ID", CF_CREDS)).toThrow(
        ConfigError,
      );
      expect(envFileOrigin("CLOUDFLARE_ACCOUNT_ID")?.source).toBe("legacy");
      expect(resolveTrustedSetting("CLOUDFLARE_ACCOUNT_ID", CF_CREDS)).toBe("my-account");
    });

    it("trusts a project base URL when the key comes from the same project file", () => {
      Reflect.deleteProperty(process.env, KEY);
      writeProject(`${NAME}=https://repo-proxy.example.net/v1\n${KEY}=sk-repo-own-key\n`);
      loadEnv(ALLOW_ALL);
      expect(resolveBaseUrl(NAME, DEFAULT, [KEY])).toBe("https://repo-proxy.example.net/v1");
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain("repo-proxy.example.net");
      expect(warnings()[0]).not.toContain("sk-repo-own-key");
    });

    it("refuses a project base URL when the key comes from the shell", () => {
      writeProject(`${NAME}=https://evil.example.net\n`);
      loadEnv(ALLOW_ALL);
      const err = refusal();
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).toContain(`${KEY} comes from the shell`);
      expect(err.message).not.toContain("sk-shell-key");
    });

    it("refuses a project base URL when the key comes from a different project file", () => {
      Reflect.deleteProperty(process.env, KEY);
      process.env.MULTIX_LEGACY_CLAUDE_ENV = "1";
      writeProject(`${NAME}=https://evil.example.net\n`);
      fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
      const other = path.join(tmp, ".claude", ".env");
      fs.writeFileSync(other, `${KEY}=sk-legacy-key\n`);
      loadEnv(ALLOW_ALL);
      expect(refusal().message).toContain(`another project file (${other})`);
    });

    it("picks the alternative credential that is actually sent", () => {
      Reflect.deleteProperty(process.env, KEY);
      const FALLBACK = "TESTPROV_API_TOKEN";
      process.env[FALLBACK] = "shell-fallback";
      try {
        writeProject(`${NAME}=https://repo-proxy.example.net\n${KEY}=sk-repo-own-key\n`);
        loadEnv(ALLOW_ALL);
        // KEY (first alternative, same file) is the one sent, so the shell fallback is irrelevant.
        expect(resolveBaseUrl(NAME, DEFAULT, [[KEY, FALLBACK]])).toBe(
          "https://repo-proxy.example.net",
        );
      } finally {
        Reflect.deleteProperty(process.env, FALLBACK);
      }
    });

    it("refuses a project routing ID when the token comes from ~/.multix/.env", () => {
      writeUser("CLOUDFLARE_API_TOKEN=cf-user-token\n");
      writeProject("CLOUDFLARE_ACCOUNT_ID=attacker-account\n");
      loadEnv(ALLOW_ALL);
      expect(() => requireCloudflareConfig()).toThrow(
        /CLOUDFLARE_API_TOKEN comes from ~\/\.multix\/\.env/,
      );
    });

    it("trusts Cloudflare IDs when the token is in the same project file", () => {
      writeProject(
        "CLOUDFLARE_API_TOKEN=cf-repo-token\nCLOUDFLARE_ACCOUNT_ID=repo-account\nCLOUDFLARE_AI_GATEWAY_ID=repo-gw\n",
      );
      loadEnv(ALLOW_ALL);
      expect(requireCloudflareConfig()).toMatchObject({
        accountId: "repo-account",
        gatewayId: "repo-gw",
      });
      expect(warn).not.toHaveBeenCalled();
      // Video also sends REPLICATE_API_TOKEN; from the shell, that would leak to the repo's gateway.
      process.env.REPLICATE_API_TOKEN = "r8-shell-token";
      expect(() => requireCloudflareVideoConfig()).toThrow(
        /REPLICATE_API_TOKEN comes from the shell/,
      );
    });

    it("multix check reports the effective state of routing settings", async () => {
      const { cloudflareReadiness, routingSettingReport } = await import(
        "../../../src/commands/check.js"
      );
      process.env.CLOUDFLARE_API_TOKEN = "cf-token-from-shell";
      writeProject(
        "CLOUDFLARE_ACCOUNT_ID=attacker-account\nFAL_BASE_URL=https://evil.example.net\n",
      );
      process.env.FAL_KEY = "fal-shell-key";
      try {
        loadEnv(ALLOW_ALL);
        const report = routingSettingReport();
        expect(report).toContainEqual({
          level: "warn",
          message:
            "CLOUDFLARE_ACCOUNT_ID ignored: set in project .env while CLOUDFLARE_API_TOKEN comes from the shell; commands that use it will stop with an error",
        });
        expect(report.map((l) => l.message).join("\n")).toContain(
          "FAL_BASE_URL ignored: set in project .env while FAL_KEY comes from the shell",
        );
        expect(report.map((l) => l.message).join("\n")).not.toContain("evil.example.net");
        expect(cloudflareReadiness()).toMatchObject({ native: false, video: false });
      } finally {
        Reflect.deleteProperty(process.env, "FAL_KEY");
        Reflect.deleteProperty(process.env, "FAL_BASE_URL");
      }
    });

    describe("multix check matches the commands", () => {
      const loadCheck = () => import("../../../src/commands/check.js");
      const messages = (lines: { message: string }[]) => lines.map((l) => l.message);
      const thrown = (fn: () => unknown): string | undefined => {
        try {
          fn();
        } catch (err) {
          return (err as Error).message;
        }
        return undefined;
      };

      it("a refused project gateway ID blocks native commands, and check says so", async () => {
        const { cloudflareReadiness, routingSettingReport } = await loadCheck();
        process.env.CLOUDFLARE_API_TOKEN = "cf-token-from-shell";
        process.env.CLOUDFLARE_ACCOUNT_ID = "my-account";
        writeProject("CLOUDFLARE_AI_GATEWAY_ID=attacker-gw\n");
        loadEnv(ALLOW_ALL);
        const readiness = cloudflareReadiness();
        expect(readiness).toMatchObject({ native: false, video: false });
        expect(readiness.nativeCheck.refused).toBe(true);
        expect(readiness.nativeCheck.problem).toBe(thrown(() => requireCloudflareConfig()));
        expect(messages(routingSettingReport())).toEqual([
          "CLOUDFLARE_ACCOUNT_ID in effect (from shell)",
          "CLOUDFLARE_AI_GATEWAY_ID ignored: set in project .env while CLOUDFLARE_API_TOKEN comes from the shell; commands that use it will stop with an error",
        ]);
      });

      it("a video token from the shell blocks video only, and check names it", async () => {
        const { cloudflareReadiness, routingSettingReport } = await loadCheck();
        writeProject(
          "CLOUDFLARE_API_TOKEN=cf-repo-token\nCLOUDFLARE_ACCOUNT_ID=repo-account\nCLOUDFLARE_AI_GATEWAY_ID=repo-gw\n",
        );
        process.env.REPLICATE_API_TOKEN = "r8-shell-token";
        loadEnv(ALLOW_ALL);
        const readiness = cloudflareReadiness();
        expect(readiness).toMatchObject({ native: true, video: false });
        expect(thrown(() => requireCloudflareConfig())).toBeUndefined();
        expect(readiness.videoCheck.refused).toBe(true);
        expect(readiness.videoCheck.problem).toBe(thrown(() => requireCloudflareVideoConfig()));
        const sameFile = "from project .env, which also holds every key sent with it";
        const videoStops =
          "ignored: set in project .env while REPLICATE_API_TOKEN comes from the shell; video commands will stop with an error";
        expect(messages(routingSettingReport())).toEqual([
          `CLOUDFLARE_ACCOUNT_ID in effect (${sameFile})`,
          `CLOUDFLARE_ACCOUNT_ID (video) ${videoStops}`,
          `CLOUDFLARE_AI_GATEWAY_ID in effect (${sameFile})`,
          `CLOUDFLARE_AI_GATEWAY_ID (video) ${videoStops}`,
        ]);
      });

      it("labels a project value used through the opt-in or because it equals the default", async () => {
        const { routingSettingReport } = await loadCheck();
        process.env.FAL_KEY = "fal-shell-key";
        process.env.LEONARDO_API_KEY = "leo-shell-key";
        writeProject(
          `FAL_BASE_URL=${FAL_ROUTING.defaultUrl}/\nLEONARDO_BASE_URL=https://repo-proxy.example.net\n`,
        );
        loadEnv(ALLOW_ALL);
        expect(messages(routingSettingReport())).toEqual([
          "FAL_BASE_URL in effect (from project .env; same as the default endpoint)",
          "LEONARDO_BASE_URL ignored: set in project .env while LEONARDO_API_KEY comes from the shell; commands that use it will stop with an error",
        ]);

        process.env[ALLOW_PROJECT_BASE_URL_ENV] = "1";
        expect(messages(routingSettingReport())).toContain(
          `LEONARDO_BASE_URL in effect (from project .env; allowed by ${ALLOW_PROJECT_BASE_URL_ENV})`,
        );
      });

      it("reports a base URL the https rule rejects, from any source", async () => {
        const { routingSettingReport } = await loadCheck();
        process.env.FAL_KEY = "fal-shell-key";
        process.env.FAL_BASE_URL = "http://proxy.example.org";
        writeUser("HEYGEN_BASE_URL=http://user-proxy.example.org\n");
        writeProject("HEYGEN_BASE_URL=https://repo-proxy.example.net\n");
        process.env.HEYGEN_API_KEY = "hg-shell-key";
        loadEnv(ALLOW_ALL);
        const report = routingSettingReport();
        const falError = thrown(() => falBaseUrl());
        expect(falError).toMatch(/FAL_BASE_URL must use https:\/\//);
        expect(report).toContainEqual({
          level: "warn",
          message: `${falError}; commands that use it will stop with an error`,
        });
        // The project value is ignored, and the ~/.multix/.env fallback fails the https rule.
        expect(messages(report).join("\n")).toContain(
          "HEYGEN_BASE_URL must use https:// (host user-proxy.example.org)",
        );
        expect(messages(report).join("\n")).not.toContain("repo-proxy.example.net");
      });
    });

    it("each provider reads its keys in the order its trust check uses", () => {
      const readers = new Map<string, () => string>([
        [ATLAS_ROUTING.name, requireAtlasKey],
        [BYTEPLUS_ROUTING.name, requireBytePlusKey],
        [FAL_ROUTING.name, requireFalKey],
        [HEYGEN_ROUTING.name, requireHeygenKey],
        [LEONARDO_ROUTING.name, requireLeonardoKey],
        [REPLICATE_ROUTING.name, requireReplicateToken],
      ]);
      for (const routing of ROUTINGS) {
        const read = readers.get(routing.name);
        if (!read) throw new Error(`no key reader for ${routing.name}`);
        routing.keyEnvs.forEach((n, i) => {
          process.env[n] = `key-${i}`;
        });
        expect(read(), routing.name).toBe("key-0");
        if (routing.keyEnvs.length > 1) {
          // A blank first name is skipped by the provider and by the trust check alike.
          process.env[routing.keyEnvs[0]] = "  ";
          expect(read(), routing.name).toBe("key-1");
        }
      }

      // End to end: shell keys plus a project base URL refuse, naming the key the provider sends.
      _resetEnvLoader();
      for (const routing of ROUTINGS) {
        routing.keyEnvs.forEach((n, i) => {
          process.env[n] = `key-${i}`;
        });
      }
      writeProject(ROUTINGS.map((r) => `${r.name}=https://repo-proxy.example.net\n`).join(""));
      loadEnv(ALLOW_ALL);
      for (const routing of ROUTINGS) {
        expect(() => resolveProviderBaseUrl(routing)).toThrow(
          `${routing.name} is set in project env file ${path.join(tmp, ".env")}, but ${routing.keyEnvs[0]} comes from the shell`,
        );
      }
    });

    it("envNameKey upper-cases names on win32 only", () => {
      expect(envNameKey("heygen_base_url", "win32")).toBe("HEYGEN_BASE_URL");
      expect(envNameKey("Multix_Allow_Project_Base_Url", "win32")).toBe(ALLOW_PROJECT_BASE_URL_ENV);
      expect(envNameKey("heygen_base_url", "linux")).toBe("heygen_base_url");
      expect(envNameKey("HEYGEN_BASE_URL", "darwin")).toBe("HEYGEN_BASE_URL");
    });

    it("does not warn when the override equals the default", () => {
      process.env[NAME] = `${DEFAULT}/`;
      loadEnv(ALLOW_ALL);
      expect(resolveBaseUrl(NAME, DEFAULT, [KEY])).toBe(DEFAULT);
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
