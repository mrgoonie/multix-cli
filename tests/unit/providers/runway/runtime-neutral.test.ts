/**
 * The Runway client layer is meant to be reusable outside Node (a Cloudflare
 * Worker MCP), so these modules must not reach node:* builtins, dotenv or
 * `process.` through their imports. The Worker does not bundle them yet, so
 * its bundle check would not catch a regression.
 */

import { describe, expect, it } from "vitest";
import { findNodeOnlyUses, formatNodeOnlyUses } from "../../../helpers/import-graph.js";

describe("Runway runtime-neutral modules", () => {
  it.each(["client.ts", "models.ts", "types.ts"])(
    "%s reaches no Node built-ins, dotenv or process through its imports",
    (file) => {
      expect(formatNodeOnlyUses(findNodeOnlyUses(`src/providers/runway/${file}`))).toEqual([]);
    },
  );
});
