/**
 * The TopView client layer is meant to be reusable outside Node (a Cloudflare
 * Worker MCP), so these modules must not reach node:* builtins, dotenv or
 * `process.` through their imports.
 */

import { describe, expect, it } from "vitest";
import { findNodeOnlyUses, formatNodeOnlyUses } from "../../../helpers/import-graph.js";

describe("TopView runtime-neutral modules", () => {
  it.each(["types.ts", "models.ts", "errors.ts", "legacy-client.ts", "platform-client.ts"])(
    "%s reaches no Node built-ins, dotenv or process through its imports",
    (file) => {
      expect(formatNodeOnlyUses(findNodeOnlyUses(`src/providers/topview/${file}`))).toEqual([]);
    },
  );
});
