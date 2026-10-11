/**
 * Smoke tests for the programmatic entry (package.json main/types/exports["."]).
 * Requires `npm run build`. The import runs in a child `node` through the
 * package's own name, so Node resolves `exports` exactly as a consumer would.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "./child-env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  name: string;
  main: string;
  types: string;
  exports: Record<string, Record<string, string>>;
};
const SPAWN_TIMEOUT = 15_000;

/** Prints `typeof` of every export of the package entry as one JSON line. */
const PROBE = `const m = await import(${JSON.stringify(pkg.name)});
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v]))));`;

describe("package entry (smoke)", { timeout: SPAWN_TIMEOUT }, () => {
  it("declares files that the build produced", () => {
    for (const rel of [pkg.main, pkg.types, pkg.exports["."]?.import, pkg.exports["."]?.types]) {
      expect(rel, "package.json entry field").toBeTruthy();
      expect(fs.existsSync(path.join(ROOT, rel as string)), `${rel} exists`).toBe(true);
    }
  });

  it("keeps the shebang on the CLI bundle only", () => {
    const head = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8").slice(0, 20);
    expect(head("dist/cli.js").startsWith("#!/usr/bin/env node")).toBe(true);
    expect(head(pkg.main).startsWith("#!")).toBe(false);
  });

  it("imports by package name, exposes the public API, and has no side effects", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-lib-"));
    try {
      // `--help` in argv would make the CLI print usage; the library must ignore it.
      const result = await execa("node", ["--input-type=module", "-e", PROBE, "--", "--help"], {
        cwd: ROOT,
        env: isolatedEnv(tmp),
        extendEnv: false,
        reject: false,
        timeout: SPAWN_TIMEOUT - 1_000,
      });
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);

      const exportsByName = JSON.parse(result.stdout) as Record<string, string>;
      for (const name of [
        "loadEnv",
        "isProjectEnvName",
        "resolveKey",
        "redact",
        "fetchJson",
        "pollUntil",
        "createLogger",
        "MultixError",
        "ProviderError",
      ]) {
        expect(exportsByName[name], name).toBe("function");
      }
      expect(exportsByName.PROJECT_ENV_NAMES).toBeDefined();

      // Importing must not create output or temp files.
      expect(fs.readdirSync(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ships declarations for the public API", () => {
    const dts = fs.readFileSync(path.join(ROOT, pkg.types), "utf8");
    expect(dts).toMatch(/declare function loadEnv\(/);
    expect(dts).toMatch(/isProjectEnvName/);
    expect(dts).not.toMatch(/from ['"]\.\.?\//);
  });
});
