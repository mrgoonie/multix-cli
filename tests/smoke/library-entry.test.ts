/**
 * Smoke tests for the programmatic entry (package.json main/types/exports["."]).
 * Requires `npm run build`. The import runs in a child `node` inside a temp
 * consumer project whose node_modules links back to this package, so Node
 * resolves `exports` exactly as a consumer would.
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
/** Test-only helpers that must stay out of the published entry. */
const INTERNAL = ["_resetEnvLoader", "_resetOutputDir"];
/** An allowed project `.env` name with a dummy value; set only if loadEnv runs. */
const SENTINEL = "MULTIX_IMAGE_FORMAT";

/**
 * Prints the `typeof` of every export, the sentinel before and after the
 * import, and the sentinel after an explicit loadEnv() (proves the probe can
 * see a load), as one JSON line.
 */
const PROBE = `const before = process.env.${SENTINEL} ?? null;
const m = await import(${JSON.stringify(pkg.name)});
const afterImport = process.env.${SENTINEL} ?? null;
const types = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v]));
m.loadEnv();
const afterLoad = process.env.${SENTINEL} ?? null;
process.stdout.write(JSON.stringify({ types, before, afterImport, afterLoad }));`;

describe("package entry (smoke)", { timeout: SPAWN_TIMEOUT }, () => {
  it("declares files that the build produced", () => {
    const entry = pkg.exports["."];
    for (const rel of [pkg.main, pkg.types, entry?.types, entry?.import, entry?.default]) {
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
    const consumer = path.join(tmp, "consumer");
    const link = path.join(consumer, "node_modules", ...pkg.name.split("/"));
    try {
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(ROOT, link, "junction");
      fs.writeFileSync(path.join(consumer, ".env"), `${SENTINEL}=sentinel-dummy\n`);
      const outDir = path.join(tmp, "out");

      const { [SENTINEL]: _inherited, ...inherited } = isolatedEnv(tmp);
      const env = { ...inherited, MULTIX_OUTPUT_DIR: outDir };
      // `--help` in argv would make the CLI print usage; the library must ignore it.
      const result = await execa("node", ["--input-type=module", "-e", PROBE, "--", "--help"], {
        cwd: consumer,
        env,
        extendEnv: false,
        reject: false,
        timeout: SPAWN_TIMEOUT - 1_000,
      });
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);

      const probe = JSON.parse(result.stdout) as {
        types: Record<string, string>;
        before: string | null;
        afterImport: string | null;
        afterLoad: string | null;
      };
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
        expect(probe.types[name], name).toBe("function");
      }
      expect(probe.types.PROJECT_ENV_NAMES).toBeDefined();
      for (const name of INTERNAL) expect(probe.types[name], name).toBeUndefined();

      // Importing must not load .env files; an explicit loadEnv() does.
      expect(probe.before).toBeNull();
      expect(probe.afterImport).toBeNull();
      expect(probe.afterLoad).toBe("sentinel-dummy");

      // Neither the import nor loadEnv may create the output directory.
      expect(fs.existsSync(outDir)).toBe(false);
    } finally {
      // Remove the link itself first so the recursive delete never follows it into the repo.
      if (fs.existsSync(link)) fs.unlinkSync(link);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ships declarations for the public API", () => {
    const dts = fs.readFileSync(path.join(ROOT, pkg.types), "utf8");
    expect(dts).toMatch(/declare function loadEnv\(/);
    expect(dts).toMatch(/isProjectEnvName/);
    expect(dts).not.toMatch(/from ['"]\.\.?\//);
    for (const name of INTERNAL) expect(dts).not.toContain(name);
  });
});
