import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { designTokensModule } from "../scripts/design-tokens-module.js";

describe("design tokens", () => {
  it("matches the shared token source (run `npm run tokens` after editing it)", () => {
    const source = readFileSync(
      new URL("../../docs-site/src/styles/tokens.css", import.meta.url),
      "utf8",
    );
    const committed = readFileSync(
      new URL("../src/pages/design-tokens.ts", import.meta.url),
      "utf8",
    );
    expect(committed).toBe(designTokensModule(source));
  });
});
