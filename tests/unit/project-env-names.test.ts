import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetEnvLoader,
  getLoadedEnvFiles,
  loadEnv,
  resolveKey,
} from "../../src/core/env-loader.js";
import { PROJECT_ENV_NAMES, isProjectEnvName } from "../../src/project-env-names.js";

const ROOT = path.resolve(__dirname, "../..");

/** Variables a hostile project .env could use to change multix or the tools it spawns. */
const HOSTILE = [
  "NODE_OPTIONS",
  "npm_config_registry",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "MAGICK_CONFIGURE_PATH",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "PATH",
];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith(".ts") ? [p] : [];
  });
}

describe("project env allowlist", () => {
  it("allows every variable listed in .env.example", () => {
    const text = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
    const names = [...text.matchAll(/^#?\s*([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(40);
    expect(names.filter((n) => !isProjectEnvName(n, "linux"))).toEqual([]);
  });

  it("allows every variable the source reads by name", () => {
    const patterns = [
      /process\.env\.([A-Z][A-Z0-9_]*)/g,
      /process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g,
      /resolveKey\(["']([A-Z][A-Z0-9_]*)["']\)/g,
      /\b[A-Z][A-Z0-9_]*_ENV\s*=\s*["']([A-Z][A-Z0-9_]*)["']/g,
    ];
    const read = new Set<string>();
    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const text = fs.readFileSync(file, "utf8");
      for (const re of patterns) for (const m of text.matchAll(re)) read.add(m[1]);
    }
    expect(read.size).toBeGreaterThan(20);
    expect([...read].filter((n) => !isProjectEnvName(n, "linux"))).toEqual([]);
  });

  it("covers provider keys, base URLs, MULTIX_* and numbered Gemini keys", () => {
    for (const name of [
      "GEMINI_API_KEY",
      "GEMINI_API_KEY_2",
      "GEMINI_API_KEY_17",
      "OPENAI_API_KEY",
      "ELEVENLABS_API_KEY",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_AI_GATEWAY_ID",
      "REPLICATE_API_KEY",
      "ARK_API_KEY",
      "HEYGEN_BASE_URL",
      "FAL_BASE_URL",
      "MULTIX_OUTPUT_DIR",
      "MULTIX_IMAGE_FORMAT",
    ]) {
      expect(isProjectEnvName(name, "linux"), name).toBe(true);
    }
    expect(PROJECT_ENV_NAMES.has("ATLASCLOUD_IMAGE_TO_3D_MODEL")).toBe(true);
  });

  it("refuses process, proxy, TLS and loader variables", () => {
    for (const name of [...HOSTILE, "GEMINI_API_KEY_X", "MULTIX", "ANTHROPIC_API_KEY"]) {
      expect(isProjectEnvName(name, "linux"), name).toBe(false);
      expect(isProjectEnvName(name, "win32"), name).toBe(false);
    }
  });

  it("ignores case on Windows only, as the OS does", () => {
    expect(isProjectEnvName("heygen_base_url", "win32")).toBe(true);
    expect(isProjectEnvName("heygen_base_url", "linux")).toBe(false);
    expect(isProjectEnvName("multix_output_dir", "win32")).toBe(true);
    expect(isProjectEnvName("node_options", "win32")).toBe(false);
  });

  describe("loadEnv with the allowlist", () => {
    const VARS = [
      ...HOSTILE.filter((n) => n !== "PATH"),
      "GEMINI_API_KEY",
      "MULTIX_OUTPUT_DIR",
      "MULTIX_DISABLE_HOME_ENV",
    ];
    const saved: Record<string, string | undefined> = {};
    let tmp: string;
    let home: string;
    let warn: ReturnType<typeof vi.spyOn>;
    const load = () => loadEnv({ isProjectEnvName });
    const writeProject = (body: string) => fs.writeFileSync(path.join(tmp, ".env"), body);
    const warnings = () => warn.mock.calls.map((c) => String(c[0]));

    beforeEach(() => {
      _resetEnvLoader();
      for (const v of VARS) {
        saved[v] = process.env[v];
        Reflect.deleteProperty(process.env, v);
      }
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-allow-"));
      home = fs.mkdtempSync(path.join(os.tmpdir(), "multix-allow-home-"));
      vi.spyOn(process, "cwd").mockReturnValue(tmp);
      vi.spyOn(os, "homedir").mockReturnValue(home);
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
      _resetEnvLoader();
      for (const v of VARS) {
        if (saved[v] === undefined) Reflect.deleteProperty(process.env, v);
        else process.env[v] = saved[v];
      }
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    });

    it("keeps NODE_OPTIONS, npm_config_registry and LD_PRELOAD out of process.env", () => {
      writeProject(
        [
          "# project settings",
          "GEMINI_API_KEY=project-key",
          "MULTIX_OUTPUT_DIR=./out",
          "NODE_OPTIONS=--require ./evil.js",
          "npm_config_registry=https://registry.evil.example",
          "LD_PRELOAD=/tmp/evil.so",
          "HTTPS_PROXY=http://proxy.evil.example:8080",
          "",
        ].join("\n"),
      );
      load();

      expect(resolveKey("GEMINI_API_KEY")).toBe("project-key");
      expect(process.env.MULTIX_OUTPUT_DIR).toBe("./out");
      for (const name of ["NODE_OPTIONS", "npm_config_registry", "LD_PRELOAD", "HTTPS_PROXY"]) {
        expect(process.env[name], name).toBeUndefined();
      }
      expect(getLoadedEnvFiles()).toEqual([path.join(tmp, ".env")]);

      // One warning naming the ignored variables, never their values.
      expect(warnings()).toHaveLength(1);
      const [message] = warnings();
      expect(message).toContain("NODE_OPTIONS, npm_config_registry, LD_PRELOAD, HTTPS_PROXY");
      expect(message).toContain(path.join(tmp, ".env"));
      for (const value of ["evil", "project-key", "./out"]) expect(message).not.toContain(value);

      // At most once per run.
      load();
      expect(warnings()).toHaveLength(1);
    });

    it("does not warn for an empty file or one with only comments and allowed names", () => {
      writeProject("");
      load();
      expect(warn).not.toHaveBeenCalled();

      _resetEnvLoader();
      writeProject("# NODE_OPTIONS=--inspect\n\nGEMINI_API_KEY=k\n");
      load();
      expect(warn).not.toHaveBeenCalled();
      expect(process.env.NODE_OPTIONS).toBeUndefined();
    });

    it("leaves shell variables and the user-level file unfiltered", () => {
      process.env.NODE_OPTIONS = "--max-old-space-size=4096";
      fs.mkdirSync(path.join(home, ".multix"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".multix", ".env"),
        "HTTPS_PROXY=http://corp-proxy.example:3128\n",
      );
      writeProject("NODE_OPTIONS=--require ./evil.js\n");
      load();

      expect(process.env.NODE_OPTIONS).toBe("--max-old-space-size=4096");
      expect(process.env.HTTPS_PROXY).toBe("http://corp-proxy.example:3128");
    });
  });
});
