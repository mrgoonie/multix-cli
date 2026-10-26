import { describe, expect, it } from "vitest";
import { extractUsage, hasUsage } from "../../../src/core/usage-extract.js";

describe("extractUsage", () => {
  it("reads Gemini usageMetadata tokens", () => {
    const usage = extractUsage({
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 1290,
        totalTokenCount: 1302,
        thoughtsTokenCount: 4,
      },
    });
    expect(usage.tokens).toEqual({ input: 12, output: 1290, total: 1302, thinking: 4 });
    expect(hasUsage(usage)).toBe(true);
  });

  it("reads OpenAI/OpenRouter usage with cost", () => {
    const usage = extractUsage({
      id: "gen-123",
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.0042 },
    });
    expect(usage.tokens).toMatchObject({ input: 10, output: 20, total: 30 });
    expect(usage.cost_usd).toBe(0.0042);
    expect(usage.ids).toContain("gen-123");
  });

  it("keeps provider metrics and credits, skips dimensions and timestamps", () => {
    const usage = extractUsage({
      task_id: "t-1",
      metrics: { predict_time: 3.2 },
      apiCreditCost: 15,
      width: 1024,
      created_at: 1700000000,
    });
    expect(usage.metrics).toMatchObject({ "metrics.predict_time": 3.2, apiCreditCost: 15 });
    expect(usage.credits).toBe(15);
    expect(usage.credits_source).toBe("apiCreditCost");
    expect(usage.metrics.width).toBeUndefined();
    expect(usage.metrics.created_at).toBeUndefined();
    expect(usage.ids).toEqual(["t-1"]);
  });

  it("reads usage headers and request ids", () => {
    const headers = new Headers({ "x-request-id": "req_abc", "character-cost": "42" });
    const usage = extractUsage(undefined, headers);
    expect(usage.metrics["header.character-cost"]).toBe(42);
    expect(usage.credits).toBe(42);
    expect(usage.credits_source).toBe("header.character-cost");
    expect(usage.ids).toEqual(["req_abc"]);
  });

  it("finds nothing in a plain body", () => {
    expect(hasUsage(extractUsage({ status: "ok", url: "https://x" }))).toBe(false);
  });
});
