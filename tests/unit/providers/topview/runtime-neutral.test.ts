/**
 * The TopView clients, models, cost estimator and platform registry must stay
 * reusable outside Node (the Worker imports the budget estimator, which reaches
 * cost.ts), so these modules must not reach node:* builtins, dotenv or
 * `process.` through their imports.
 */

import { describe, expect, it } from "vitest";
import { findNodeOnlyUses, formatNodeOnlyUses } from "../../../helpers/import-graph.js";

describe("TopView runtime-neutral modules", () => {
  it.each([
    "client.ts",
    "models.ts",
    "types.ts",
    "cost.ts",
    "platform-client.ts",
    "platform-models.ts",
  ])("%s reaches no Node built-ins, dotenv or process through its imports", (file) => {
    expect(formatNodeOnlyUses(findNodeOnlyUses(`src/providers/topview/${file}`))).toEqual([]);
  });
});
