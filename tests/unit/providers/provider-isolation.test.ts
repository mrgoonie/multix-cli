import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PROVIDERS_DIR = path.resolve("src/providers");
// Static, side-effect, re-export and dynamic imports of an openrouter/ path.
const OPENROUTER_IMPORT = /(?:from\s+|import\s*\(?\s*)["'][^"']*\/openrouter\//;

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("provider isolation", () => {
  it("no provider other than OpenRouter imports from providers/openrouter", () => {
    const openrouterDir = path.join(PROVIDERS_DIR, "openrouter") + path.sep;
    const offenders = tsFiles(PROVIDERS_DIR)
      .filter((file) => !file.startsWith(openrouterDir))
      .filter((file) => OPENROUTER_IMPORT.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(process.cwd(), file));
    expect(offenders).toEqual([]);
  });

  it("matches the import forms it guards against", () => {
    for (const line of [
      'import { readCappedText } from "../openrouter/speech-client.js";',
      'export { x } from "../openrouter/speech-client.js";',
      'import "../openrouter/side-effect.js";',
      'await import("../openrouter/speech-client.js");',
    ]) {
      expect(OPENROUTER_IMPORT.test(line)).toBe(true);
    }
    expect(
      OPENROUTER_IMPORT.test('import { readCappedText } from "../../core/response-read.js";'),
    ).toBe(false);
  });
});
