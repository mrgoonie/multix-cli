/**
 * Lyria is billed per song: $0.04 for a lyria-3-clip-preview clip and $0.08
 * for a lyria-3.5 song. The estimate is a proven flat price that --max-cost
 * can enforce, and the receipt computes the actual cost from the request
 * count the command records. Lyria RealTime has no published price, so its
 * estimate stays unknown. Pure functions, no network.
 */

import { describe, expect, it } from "vitest";
import { checkBudget, estimateCommand, pricedCommands } from "../../../src/budget/command-cost.js";
import { buildCostReceipt } from "../../../src/budget/cost-receipt.js";
import { BudgetError } from "../../../src/core/errors.js";

const AT = new Date("2026-10-31T12:00:00Z");

describe("gemini generate-music cost", () => {
  it("prices the default clip model and the full-song model per request", () => {
    expect(pricedCommands()).toContain("gemini generate-music");
    expect(estimateCommand("gemini generate-music", {}, { at: AT })).toMatchObject({
      status: "estimated",
      upper_bound: "proven",
      low_usd: 0.04,
      high_usd: 0.04,
      units: { requests: { low: 1, expected: 1, high: 1 } },
    });
    const song = estimateCommand("gemini generate-music", { model: "lyria-3.5" }, { at: AT });
    expect(song).toMatchObject({ status: "estimated", low_usd: 0.08, high_usd: 0.08 });
    expect(song.rate?.id).toBe("gemini/lyria-3.5@paid-standard");
  });

  it("enforces --max-cost against the per-song price", () => {
    const e = estimateCommand("gemini generate-music", { model: "lyria-3.5" }, { at: AT });
    expect(() => checkBudget(e, 0.05, "strict")).toThrow(BudgetError);
    expect(() => checkBudget(e, 0.08, "strict")).not.toThrow();
  });

  it("computes the actual cost from the recorded request", () => {
    const receipt = buildCostReceipt({
      operation_id: "op",
      outcome: "ok",
      provider: "gemini",
      model: "lyria-3.5",
      calls: [{ method: "POST", status: 200 }],
      usage: { metrics: { "request.count": 1 } },
      estimate: estimateCommand("gemini generate-music", { model: "lyria-3.5" }, { at: AT }),
      at: AT,
    });
    expect(receipt).toMatchObject({ status: "computed", actual_usd: 0.08, variance_usd: 0 });
  });

  it("leaves Lyria RealTime unpriced", () => {
    expect(pricedCommands()).not.toContain("gemini music-live");
    expect(estimateCommand("gemini music-live", {}, { at: AT }).status).not.toBe("estimated");
  });
});
