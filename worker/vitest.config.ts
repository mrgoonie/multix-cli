import { defineConfig } from "vitest/config";

// The handler's fetch() is exercised directly in Node with mocked provider and
// GitHub fetch and in-memory KV; no paid provider is ever called.
export default defineConfig({
  resolve: {
    alias: {
      // workers-oauth-provider imports WorkerEntrypoint from the Workers runtime.
      // A leading "/" is resolved from the Vite root (this package).
      "cloudflare:workers": "/test/stubs/cloudflare-workers.ts",
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Bundle the library through Vite so the cloudflare:workers alias applies to it.
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider", "@cloudflare/containers"] } },
  },
});
