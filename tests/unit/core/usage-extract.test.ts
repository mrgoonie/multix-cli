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
    expect(usage.metrics.width).toBeUndefined();
    expect(usage.metrics.created_at).toBeUndefined();
    expect(usage.ids).toEqual(["t-1"]);
  });

  it("keeps an account balance in metrics but never reports it as credits spent", () => {
    // Leonardo GET /me: apiCredit is the remaining API credit balance.
    const leonardo = extractUsage({
      user_details: [{ user: { id: "u1" }, apiCredit: 1000, subscriptionTokens: 500 }],
    });
    expect(leonardo.metrics["user_details[0].apiCredit"]).toBe(1000);
    expect(leonardo.credits).toBeUndefined();
    expect(leonardo.cost_usd).toBeUndefined();

    // HeyGen GET /v3/users/me: wallet, subscription and usage-based allowances.
    const heygen = extractUsage({
      data: {
        billing_type: "usage_based",
        wallet: { currency: "usd", remaining_balance: 42.5 },
        subscription: {
          plan: "pro",
          credits: { premium_credits: { remaining: 300 }, add_on_credits: { remaining: 20 } },
        },
        usage_based: {
          spending_current_usd: 3,
          included_credits: 100,
          remaining_credits: 97,
        },
      },
    });
    expect(heygen.metrics).toMatchObject({
      "data.usage_based.included_credits": 100,
      "data.usage_based.remaining_credits": 97,
    });
    expect(heygen.credits).toBeUndefined();
    expect(heygen.cost_usd).toBeUndefined();

    for (const body of [
      { credits_remaining: 50 },
      { available_credits: 50 },
      { billing: { balance: { usd: 12 } } },
      { subscription: { credits: 300 } },
    ]) {
      const usage = extractUsage(body);
      expect(usage.credits).toBeUndefined();
      expect(usage.cost_usd).toBeUndefined();
    }
  });

  it("still reports credits spent next to a balance in the same response", () => {
    const usage = extractUsage({
      remainingCredits: 992,
      sdGenerationJob: { generationId: "g-1", apiCreditCost: 8 },
    });
    expect(usage.credits).toBe(8);
    expect(usage.metrics.remainingCredits).toBe(992);
  });

  it("matches balance parents by whole segment, not substring", () => {
    expect(extractUsage({ subscription_job: { credits: 4 } }).credits).toBe(4);
    expect(extractUsage({ job: { apiCreditCost: 3 } }).credits).toBe(3);
  });

  it("keeps estimates in metrics but never reports them as credits or cost", () => {
    const usage = extractUsage({
      id: "t1",
      estimatedCost: { credits: 60 },
      quote: { credits: 3 },
      expected_credits: 7,
      usage: { estimated: { cost: 0.25 } },
    });
    expect(usage.metrics).toMatchObject({
      "estimatedCost.credits": 60,
      "quote.credits": 3,
      expected_credits: 7,
      "usage.estimated.cost": 0.25,
    });
    expect(usage.credits).toBeUndefined();
    expect(usage.cost_usd).toBeUndefined();
  });

  it("reports credits charged next to an estimate", () => {
    const usage = extractUsage({ estimatedCost: { credits: 60 }, cost: { credits: 55 } });
    expect(usage.credits).toBe(55);
  });

  it("reads usage headers and request ids", () => {
    const headers = new Headers({ "x-request-id": "req_abc", "character-cost": "42" });
    const usage = extractUsage(undefined, headers);
    expect(usage.metrics["header.character-cost"]).toBe(42);
    expect(usage.ids).toEqual(["req_abc"]);
    expect(usage.credits).toBe(42);
    expect(usage.sources).toEqual({ credits: "header.character-cost" });
  });

  it("names the body path a cost or credit number came from", () => {
    const usage = extractUsage({ usage: { cost: 0.0021 }, apiCreditCost: 12 });
    expect(usage.sources).toEqual({ cost_usd: "body.usage.cost", credits: "body.apiCreditCost" });
  });

  it("reads OpenRouter's GET /generation total_cost", () => {
    const usage = extractUsage({ data: { id: "gen-tts-1", total_cost: 0.000048, latency: 141 } });
    expect(usage.cost_usd).toBe(0.000048);
    expect(usage.ids).toEqual(["gen-tts-1"]);
  });

  it("ignores ids of catalog entries in a list of several items", () => {
    const usage = extractUsage({ data: [{ id: "a/model-1" }, { id: "b/model-2" }] });
    expect(usage.ids).toEqual([]);
    expect(extractUsage({ data: [{ id: "job-1" }] }).ids).toEqual(["job-1"]);
  });

  it("finds nothing in a plain body", () => {
    expect(hasUsage(extractUsage({ status: "ok", url: "https://x" }))).toBe(false);
  });
});
