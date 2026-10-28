/**
 * The Sume client layer and the provider quote are reused outside Node (the
 * Cloudflare Worker MCP runs the pre-flight quote), so these modules must not
 * reach node:* builtins, dotenv or `process.` through their imports.
 */

import { describe, expect, it } from "vitest";
import { findNodeOnlyUses, formatNodeOnlyUses } from "../../../helpers/import-graph.js";

describe("Sume runtime-neutral modules", () => {
  it.each([
    "src/providers/sume/client.ts",
    "src/providers/sume/models.ts",
    "src/providers/sume/types.ts",
    "src/providers/sume/errors.ts",
    "src/providers/sume/estimate.ts",
    "src/providers/sume/request.ts",
    "src/providers/sume/catalog.ts",
    "src/budget/provider-quote.ts",
  ])("%s reaches no Node built-ins, dotenv or process through its imports", (file) => {
    expect(formatNodeOnlyUses(findNodeOnlyUses(file))).toEqual([]);
  });
});
