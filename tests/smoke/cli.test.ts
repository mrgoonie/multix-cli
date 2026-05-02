/**
 * Smoke tests — spawn the compiled dist/cli.js and assert expected output.
 * All tests use `node dist/cli.js` to avoid shebang issues on Windows.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execa } from "execa";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../dist/cli.js");

describe("multix --help (smoke)", () => {
  it("exits 0 and lists all 6 top-level commands", async () => {
    const result = await execa("node", [CLI, "--help"], { reject: false });
    expect(result.exitCode).toBe(0);

    const out = result.stdout + result.stderr;
    expect(out).toContain("check");
    expect(out).toContain("gemini");
    expect(out).toContain("minimax");
    expect(out).toContain("openrouter");
    expect(out).toContain("media");
    expect(out).toContain("doc");
  });

  it("prints version", async () => {
    const result = await execa("node", [CLI, "--version"], { reject: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
