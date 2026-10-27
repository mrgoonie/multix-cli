/**
 * Fish voice design is billed per successful request ($0.01), not per byte
 * or candidate: the estimate is a proven flat ceiling that --max-cost can
 * enforce, and the receipt computes the actual cost from the request count
 * the command records. Pure functions, no network.
 */

import { describe, expect, it } from "vitest";
import { checkBudget, estimateCommand, pricedCommands } from "../../../src/budget/command-cost.js";
import { buildCostReceipt } from "../../../src/budget/cost-receipt.js";
import { BudgetError } from "../../../src/core/errors.js";

const AT = new Date("2026-10-27T12:00:00Z");

describe("fish voice-design cost", () => {
  it("is a priced command with a proven flat $0.01 whatever the count or prompt", () => {
    expect(pricedCommands()).toEqual(expect.arrayContaining(["fish tts", "fish voice-design"]));
    for (const options of [{}, { count: "4", instruction: "a".repeat(2000) }]) {
      const e = estimateCommand("fish voice-design", options, { at: AT });
      expect(e).toMatchObject({
        status: "estimated",
        upper_bound: "proven",
        low_usd: 0.01,
        high_usd: 0.01,
        units: { requests: { low: 1, expected: 1, high: 1 } },
      });
      expect(e.rate?.id).toBe("fish/voice-design-1@api");
    }
  });

  it("enforces --max-cost against the flat price", () => {
    const e = estimateCommand("fish voice-design", {}, { at: AT });
    expect(() => checkBudget(e, 0.005, "strict")).toThrow(BudgetError);
    expect(() => checkBudget(e, 0.01, "strict")).not.toThrow();
  });

  it("computes the actual cost from the request count the command reported", () => {
    const receipt = buildCostReceipt({
      operation_id: "op",
      outcome: "ok",
      provider: "fish",
      model: "voice-design-1",
      calls: [{ method: "POST", status: 200 }],
      usage: { metrics: { "request.count": 1 } },
      estimate: estimateCommand("fish voice-design", {}, { at: AT }),
      at: AT,
    });
    expect(receipt).toMatchObject({
      status: "computed",
      actual_usd: 0.01,
      measured: { requests: 1 },
      variance_usd: 0,
    });
  });
});
