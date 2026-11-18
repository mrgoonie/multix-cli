/**
 * The ToAPIs client layer is reused by the Cloudflare Worker, so these modules
 * must not reach node:* builtins, dotenv or `process.` through their imports.
 */

import { describe, expect, it } from "vitest";
import { findNodeOnlyUses, formatNodeOnlyUses } from "../../../helpers/import-graph.js";

describe("ToAPIs runtime-neutral modules", () => {
  it.each(["client.ts", "models.ts", "types.ts", "request-body.ts", "cost.ts"])(
    "%s reaches no Node built-ins, dotenv or process through its imports",
    (file) => {
      expect(formatNodeOnlyUses(findNodeOnlyUses(`src/providers/toapis/${file}`))).toEqual([]);
    },
  );
});
