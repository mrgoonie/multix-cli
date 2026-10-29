/**
 * The Sume client layer is meant to be reusable outside Node (a Cloudflare
 * Worker MCP), so these modules must not reach node:* builtins, dotenv or
 * `process.` through their imports. cost.ts is also bundled by the Worker
 * through src/budget/command-cost.ts.
 */

import { describe, expect, it } from "vitest";
import { findNodeOnlyUses, formatNodeOnlyUses } from "../../../helpers/import-graph.js";

describe("Sume runtime-neutral modules", () => {
  it.each(["client.ts", "models.ts", "types.ts", "request-plan.ts", "cost.ts"])(
    "%s reaches no Node built-ins, dotenv or process through its imports",
    (file) => {
      expect(formatNodeOnlyUses(findNodeOnlyUses(`src/providers/sume/${file}`))).toEqual([]);
    },
  );
});
