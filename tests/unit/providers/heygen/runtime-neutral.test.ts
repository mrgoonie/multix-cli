/**
 * The HeyGen client layer is shared with non-Node runtimes (a Cloudflare
 * Worker MCP), so these modules must not import node:* builtins or Node-only
 * core helpers, directly or through their relative imports.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const heygenDir = path.join(root, "src/providers/heygen");

const NEUTRAL = [
  "client.ts",
  "types.ts",
  "models.ts",
  "heygen-errors.ts",
  "jobs.ts",
  "request-builders.ts",
  "webhook.ts",
];

/** Node-only modules under src/core that must never be reached. */
const NODE_ONLY_CORE = ["env-loader", "http-client", "logger", "output-dir", "json-input"];

function importsOf(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const specs: string[] = [];
  for (const m of src.matchAll(/(?:import|export)[^"']*?from\s*["']([^"']+)["']/g)) {
    if (m[1]) specs.push(m[1]);
  }
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) if (m[1]) specs.push(m[1]);
  for (const m of src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) if (m[1]) specs.push(m[1]);
  return specs;
}

/** Walk relative imports transitively, returning every reached file and its specifiers. */
function closure(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    const specs = importsOf(file);
    seen.set(file, specs);
    for (const s of specs) {
      if (!s.startsWith(".")) continue;
      stack.push(path.resolve(path.dirname(file), s.replace(/\.js$/, ".ts")));
    }
  }
  return seen;
}

describe("HeyGen runtime-neutral modules", () => {
  for (const name of NEUTRAL) {
    it(`${name} has no node:* or Node-only imports (transitively)`, () => {
      const graph = closure(path.join(heygenDir, name));
      for (const [file, specs] of graph) {
        const rel = path.relative(root, file);
        for (const s of specs) {
          expect(s.startsWith("node:"), `${rel} imports ${s}`).toBe(false);
          expect(["fs", "path", "os", "crypto", "stream"].includes(s), `${rel} imports ${s}`).toBe(
            false,
          );
          const base = path.basename(s).replace(/\.js$/, "");
          expect(NODE_ONLY_CORE.includes(base), `${rel} imports ${s}`).toBe(false);
          expect(base === "node-helpers", `${rel} imports ${s}`).toBe(false);
        }
        expect(fs.readFileSync(file, "utf8")).not.toMatch(/\bprocess\.(env|stdout|stderr)\b/);
      }
    });
  }
});
