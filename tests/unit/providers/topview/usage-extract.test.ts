/**
 * What the shared usage extractor (run by fetch telemetry on every JSON
 * response) records for TopView bodies. Spend must come only from what a
 * request actually charged: Legacy costCredit counts as credits, a Platform
 * charged_usd that is still RESERVED is a hold (not final spend), and the
 * Legacy remainCredit is a balance that must never count as spend.
 */

import { describe, expect, it } from "vitest";
import { extractUsage } from "../../../../src/core/usage-extract.js";
import { PREDICTION_ID, TASK_ID } from "./fake-topview.js";

describe("extractUsage on TopView responses", () => {
  it("counts a legacy task's numeric costCredit as credits", () => {
    const usage = extractUsage({
      code: "200",
      message: "success",
      result: { taskId: TASK_ID, status: "success", costCredit: 12 },
    });
    expect(usage.credits).toBe(12);
    expect(usage.sources?.credits).toBe("body.result.costCredit");
    expect(usage.cost_usd).toBeUndefined();
  });

  it("counts a legacy costCredit sent as a decimal string", () => {
    const usage = extractUsage({ code: "200", result: { taskId: TASK_ID, costCredit: "5.00" } });
    expect(usage.credits).toBe(5);
    expect(usage.sources?.credits).toBe("body.result.costCredit");
  });

  it("counts a CAPTURED charged_usd decimal string as provider-reported USD", () => {
    const usage = extractUsage({
      code: 200,
      data: {
        id: PREDICTION_ID,
        status: "completed",
        charged_usd: "0.4160",
        billing_state: "CAPTURED",
      },
    });
    expect(usage.cost_usd).toBe(0.416);
    expect(usage.sources?.cost_usd).toBe("body.data.charged_usd");
  });

  it("does not count a RESERVED charged_usd as final USD spend", () => {
    const usage = extractUsage({
      code: 200,
      message: "OK",
      data: {
        id: PREDICTION_ID,
        status: "processing",
        code: 0,
        outputs: [],
        charged_usd: "0.400000000000",
        billing_state: "RESERVED",
        error: "",
      },
    });
    expect(usage.cost_usd).toBeUndefined();
    expect(usage.credits).toBeUndefined();
  });

  it("never counts the legacy remainCredit balance as spend", () => {
    const usage = extractUsage({
      code: "200",
      message: "success",
      result: { remainCredit: 120, expiredTime: "2026-12-31" },
    });
    expect(usage.credits).toBeUndefined();
  });
});
