import { defineConfig } from "vitest/config";

// The handler's fetch() is exercised directly in Node with mocked provider fetch;
// no paid provider is ever called.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
