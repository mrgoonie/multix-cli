/**
 * Lyria is billed per song (Clip $0.04, 3.5 $0.08), whatever the prompt,
 * lyrics or images: a proven flat ceiling that --max-cost can enforce.
 * --interaction-id re-reads a stored song and is not priced. Pure functions.
 */

import { describe, expect, it } from "vitest";
import { checkBudget, estimateCommand, pricedCommands } from "../../../src/budget/command-cost.js";
import { BudgetError } from "../../../src/core/errors.js";

const AT = new Date("2026-10-31T12:00:00Z");

describe("gemini generate-music cost", () => {
  it("prices one song per request by model", () => {
    expect(pricedCommands()).toContain("gemini generate-music");
    const clip = estimateCommand("gemini generate-music", { prompt: "x" }, { at: AT });
    expect(clip).toMatchObject({
      status: "estimated",
      upper_bound: "proven",
      model: "lyria-3-clip-preview",
      high_usd: 0.04,
      units: { requests: { low: 1, expected: 1, high: 1 } },
    });
    const song = estimateCommand(
      "gemini generate-music",
      { prompt: "x", lyrics: "a".repeat(3000), model: "lyria-3.5" },
      { at: AT },
    );
    expect(song).toMatchObject({ status: "estimated", high_usd: 0.08 });
    expect(song.rate?.id).toBe("gemini/lyria-3.5@paid-standard");
    expect(() => checkBudget(song, 0.05, "strict")).toThrow(BudgetError);
    expect(() => checkBudget(clip, 0.05, "strict")).not.toThrow();
  });

  it("follows the run-time default model and leaves a re-read unpriced", () => {
    expect(
      estimateCommand("gemini generate-music", {}, { at: AT, model: "lyria-3.5" }).high_usd,
    ).toBe(0.08);
    expect(
      estimateCommand("gemini generate-music", { "interaction-id": "v1_x" }, { at: AT }).status,
    ).toBe("unknown");
  });
});
