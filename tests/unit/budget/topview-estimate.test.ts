import { describe, expect, it } from "vitest";
import { checkBudget, estimateCommand, pricedCommands } from "../../../src/budget/command-cost.js";
import { BudgetError } from "../../../src/core/errors.js";

const AT = new Date("2026-10-28T12:00:00Z");
const T1 = "topview/topview-t1/text-to-video";

describe("topview estimates through estimateCommand", () => {
  it("lists topview generate as a priced command", () => {
    expect(pricedCommands()).toContain("topview generate");
  });

  it("prices topview generate, accepting MCP-style --flag keys", () => {
    const e = estimateCommand(
      "topview generate",
      { "--model": T1, "--prompt": "a cat", "--duration": "10", "--resolution": "1080p" },
      { at: AT },
    );
    expect(e).toMatchObject({
      status: "estimated",
      provider: "topview",
      model: T1,
      upper_bound: "proven",
      high_usd: 4.056,
    });
  });

  it("keeps credit-billed commands unknown so --max-cost fails closed", () => {
    const e = estimateCommand(
      "topview url-to-video",
      { productUrl: "https://x.example.com" },
      { at: AT },
    );
    expect(e).toMatchObject({ status: "unknown", reason: "credits_only", high_usd: null });
    expect(() => checkBudget(e, 100, "estimate")).toThrow(BudgetError);
  });

  it("reports non-billing topview commands as unsupported", () => {
    expect(estimateCommand("topview status", {}, { at: AT })).toMatchObject({
      status: "unknown",
      reason: "unsupported",
    });
  });

  it("enforces --max-cost against a proven cap", () => {
    const e = estimateCommand("topview generate", { model: T1, prompt: "x" }, { at: AT });
    expect(() => checkBudget(e, 1, "strict")).not.toThrow();
    expect(() => checkBudget(e, 0.5, "strict")).toThrow(BudgetError);
  });

  it("needs --cost-policy estimate for a usage-billed model", () => {
    const e = estimateCommand(
      "topview generate",
      { model: "bytedance/seedance-2.0/text-to-video", prompt: "x" },
      { at: AT },
    );
    expect(() => checkBudget(e, 10, "strict")).toThrow(/not a proven cap/);
    expect(() => checkBudget(e, 10, "estimate")).not.toThrow();
  });
});
