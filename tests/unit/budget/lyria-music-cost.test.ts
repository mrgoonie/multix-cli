/**
 * Lyria is billed per song at a flat list price ($0.04 clip, $0.08 lyria-3.5):
 * the estimate is a proven ceiling, and a run that waits for the song computes
 * its receipt from the one request it records. A later status read is an
 * observation and adds no spend. Pure functions, no network.
 */

import { describe, expect, it } from "vitest";
import { checkBudget, estimateCommand, pricedCommands } from "../../../src/budget/command-cost.js";
import { buildCostReceipt } from "../../../src/budget/cost-receipt.js";
import { BudgetError } from "../../../src/core/errors.js";

const AT = new Date("2026-10-31T12:00:00Z");

describe("gemini generate-music cost", () => {
  it("prices the default clip and lyria-3.5 at their flat list price", () => {
    expect(pricedCommands()).toContain("gemini generate-music");
    expect(estimateCommand("gemini generate-music", { prompt: "jazz" }, { at: AT })).toMatchObject({
      status: "estimated",
      upper_bound: "proven",
      high_usd: 0.04,
    });
    const song = estimateCommand(
      "gemini generate-music",
      { prompt: "jazz", "--model": "models/lyria-3.5" },
      { at: AT },
    );
    expect(song).toMatchObject({ high_usd: 0.08, upper_bound: "proven" });
    expect(() => checkBudget(song, 0.05, "strict")).toThrow(BudgetError);
  });

  it("computes the receipt of a waited song and leaves a status read unpriced", () => {
    const base = {
      operation_id: "op",
      outcome: "ok" as const,
      provider: "gemini",
      model: "lyria-3.5",
      at: AT,
    };
    expect(
      buildCostReceipt({
        ...base,
        calls: [
          { method: "POST", status: 200 },
          { method: "GET", status: 200 },
        ],
        usage: { metrics: { "request.count": 1 } },
      }),
    ).toMatchObject({ role: "charge", status: "computed", actual_usd: 0.08 });
    expect(buildCostReceipt({ ...base, calls: [{ method: "GET", status: 200 }] })).toMatchObject({
      role: "observation",
      status: "unknown",
      actual_usd: null,
    });
  });
});
