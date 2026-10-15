/**
 * The Runway client layer can be reused by non-Node runtimes (the Cloudflare
 * Worker MCP), so these modules must not reach Node built-ins, dotenv or
 * `process` through their imports.
 */

import { describe, expect, it } from "vitest";
import { findNodeOnlyUses, formatNodeOnlyUses } from "../../../helpers/import-graph.js";

const NEUTRAL = ["client.ts", "models.ts", "output.ts", "types.ts"];

describe("Runway runtime-neutral modules", () => {
  it.each(NEUTRAL)("%s reaches no Node built-ins, dotenv or process", (file) => {
    expect(formatNodeOnlyUses(findNodeOnlyUses(`src/providers/runway/${file}`))).toEqual([]);
  });
});
