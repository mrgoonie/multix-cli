#!/usr/bin/env node
/**
 * Fail when the built Worker bundle pulls in Node-only modules or the CLI.
 * Usage: node scripts/check-bundle.mjs <dir-or-file> (default: dist)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [
  { label: "node:fs", re: /["'](?:node:)?fs(?:\/promises)?["']/ },
  { label: "node:child_process", re: /["'](?:node:)?child_process["']/ },
  { label: "commander", re: /["']commander["']|\bCommanderError\b/ },
  { label: "execa", re: /["']execa["']/ },
  { label: "src/cli.ts", re: /\.name\(\s*["']multix["']\s*\)/ },
];

function bundleFiles(target) {
  if (statSync(target).isFile()) return [target];
  return readdirSync(target, { recursive: true })
    .map((name) => join(target, String(name)))
    .filter((file) => /\.(m?js|cjs)$/.test(file) && statSync(file).isFile());
}

const target = process.argv[2] ?? "dist";
const files = bundleFiles(target);
if (files.length === 0) {
  console.error(`check-bundle: no JavaScript files found in ${target}`);
  process.exit(1);
}

let failed = false;
for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const { label, re } of FORBIDDEN) {
    if (re.test(source)) {
      console.error(`check-bundle: ${file} contains forbidden ${label}`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log(
  `check-bundle: ${files.length} file(s) clean (${FORBIDDEN.map((f) => f.label).join(", ")})`,
);
