import { defineConfig } from "tsup";

/**
 * One build for both entries so `clean` runs once and cannot race a second
 * config. The CLI shebang lives in src/cli.ts (esbuild keeps an entry's
 * hashbang), so the library entry dist/index.js is emitted without one.
 * Declarations are generated for the programmatic entry only.
 */
export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node20",
  clean: true,
  dts: {
    entry: { index: "src/index.ts" },
  },
  sourcemap: false,
  splitting: false,
  outDir: "dist",
});
