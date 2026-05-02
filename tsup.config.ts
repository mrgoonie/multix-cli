import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  banner: {
    js: "#!/usr/bin/env node",
  },
  clean: true,
  dts: false,
  sourcemap: false,
  splitting: false,
  outDir: "dist",
});
