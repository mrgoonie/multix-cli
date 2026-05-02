import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/cli.ts", "src/index.ts"],
      thresholds: {
        lines: 70,
      },
    },
    // Disable real home env loading in all tests
    env: {
      MULTIX_DISABLE_HOME_ENV: "1",
    },
  },
});
