// Bundles the export script, writes model-pricing-data.json and inlines it into preview.html.
// Run from the repo root: node plans/261119-1214-model-pricing-page/build-preview.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = path.dirname(new URL(import.meta.url).pathname);
const tmp = mkdtempSync(path.join(os.tmpdir(), "mx-pricing-"));
const esbuild = process.env.ESBUILD ?? "node_modules/.bin/esbuild";
execFileSync(
  esbuild,
  [
    path.join(dir, "export-model-pricing-data.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${tmp}/export.mjs`,
    "--log-level=warning",
  ],
  { stdio: "inherit" },
);
const json = path.join(dir, "model-pricing-data.json");
execFileSync("node", [`${tmp}/export.mjs`, json], { stdio: "inherit" });
const data = readFileSync(json, "utf8").replace(/</g, "\\u003c");
const html = readFileSync(path.join(dir, "preview-template.html"), "utf8").replace(
  "/*__DATA__*/null",
  () => data,
);
writeFileSync(path.join(dir, "preview.html"), html);
console.log("wrote", path.join(dir, "preview.html"));
