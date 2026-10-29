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

  it("reports a spend leaf as credits even when it names a balance", () => {
    for (const [body, path] of [
      [{ quota_credits_used: 6 }, "quota_credits_used"],
      [{ included_credits_used: 6 }, "included_credits_used"],
      [{ subscription: { credits_used: 6 } }, "subscription.credits_used"],
      [{ wallet: { creditsSpent: 6 } }, "wallet.creditsSpent"],
      [{ allowance_credits_consumed: 6 }, "allowance_credits_consumed"],
      [{ granted_credits_charged: 6 }, "granted_credits_charged"],
      [{ quotaAPICreditsUsed: 6 }, "quotaAPICreditsUsed"],
      [{ quotaCreditsUsed30d: 6 }, "quotaCreditsUsed30d"],
    ] as const) {
      const usage = extractUsage(body);
      expect(usage.credits).toBe(6);
      expect(usage.sources?.credits).toBe(`body.${path}`);
    }
  });

  it("matches spend words whole, so unused credits stay a balance", () => {
    for (const body of [
      { unused_credits: 40 },
      { included_unused_credits: 40 },
      { subscription: { unusedCredits: 40 } },
      { credits_left: 40 },
    ]) {
      expect(extractUsage(body).credits).toBeUndefined();
    }
    expect(extractUsage({ quota_credits_used: 2, quota_credits: 40 }).credits).toBe(2);
  });

  it("prefers a plain spend key over a spend key inside a balance", () => {
    const usage = extractUsage({ subscription: { credits_used: 1200 }, job: { credits: 5 } });
    expect(usage.credits).toBe(5);
    expect(usage.sources?.credits).toBe("body.job.credits");
    expect(usage.metrics["subscription.credits_used"]).toBe(1200);
    const cost = extractUsage({ subscription: { usage: { cost: 12.5 } }, usage: { cost: 0.2 } });
    expect(cost.cost_usd).toBe(0.2);
    const both = extractUsage({ usage: { cost: 0.2 }, subscription: { credits_used: 7 } });
    expect(both).toMatchObject({ cost_usd: 0.2, credits: 7 });
    expect(extractUsage({ APICredits: 900 }).credits).toBeUndefined();
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

  it("reads OpenRouter's x-generation-id header as an id", () => {
    const usage = extractUsage(
      { usage: { cost: 0.1 } },
      new Headers({ "x-generation-id": "gen-9" }),
    );
    expect(usage.ids).toEqual(["gen-9"]);
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

/**
 * Decimal-string amounts, the `remain` balance word, `charged_usd`, billing_state
 * holds and charge summaries apply to every provider: these bodies from other
 * providers must extract exactly what they did before those rules existed.
 */
describe("extractUsage on other providers' bodies", () => {
  it("counts an OpenRouter chat completion's numeric usage.cost once, with its tokens", () => {
    const usage = extractUsage({
      id: "gen-1",
      model: "openai/gpt-4o-mini",
      status: "reserved",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0123 },
    });
    expect(usage).toEqual({
      tokens: { input: 10, output: 5, total: 15 },
      cost_usd: 0.0123,
      metrics: {
        "usage.prompt_tokens": 10,
        "usage.completion_tokens": 5,
        "usage.total_tokens": 15,
        "usage.cost": 0.0123,
      },
      ids: ["gen-1"],
      sources: { cost_usd: "body.usage.cost" },
    });
  });

  it("keeps a fal queue result's timing metrics without inventing a cost", () => {
    const usage = extractUsage({
      request_id: "req-fal-1",
      status: "COMPLETED",
      metrics: { inference_time: 1.25 },
    });
    expect(usage).toEqual({
      tokens: {},
      metrics: { "metrics.inference_time": 1.25 },
      ids: ["req-fal-1"],
    });
  });

  it("keeps a Replicate prediction's predict_time, and no string becomes an amount", () => {
    const usage = extractUsage({
      id: "rep-1",
      status: "succeeded",
      version: "5.1",
      metrics: { predict_time: 3.5, total_time: 4 },
      urls: { get: "https://api.replicate.com/v1/predictions/rep-1" },
    });
    expect(usage.cost_usd).toBeUndefined();
    expect(usage.credits).toBeUndefined();
    expect(usage.metrics).toEqual({ "metrics.predict_time": 3.5, "metrics.total_time": 4 });
  });

  it("counts a numeric cost beside a status object that is not a charge summary", () => {
    const usage = extractUsage({
      data: { status: "reserved", usage: { status: "pending", cost: 0.2, credits: 4 } },
    });
    expect(usage).toMatchObject({ cost_usd: 0.2, credits: 4 });
  });

  it("still separates spent credits from remaining ones", () => {
    const usage = extractUsage({
      usage: { credits_remaining: 90, remaining_credits: 90, credits: 2 },
    });
    expect(usage.credits).toBe(2);
  });

  it("counts a numeric charged_usd unless its billing_state is a hold", () => {
    expect(extractUsage({ charged_usd: 0.4 }).cost_usd).toBe(0.4);
    expect(extractUsage({ charged_usd: 0.4, billing_state: "CAPTURED" }).cost_usd).toBe(0.4);
    expect(extractUsage({ charged_usd: 0.4, billing_state: "RESERVED" }).cost_usd).toBeUndefined();
  });

  it("reads a charge summary's captured cents only once it is final", () => {
    const summary = (status: string, cents: number) =>
      extractUsage({ data: { usage_summary: { status, captured_usd_cents: cents } } }).cost_usd;
    expect(summary("captured", 35)).toBe(0.35);
    expect(summary("refunded", 0)).toBe(0);
    expect(summary("reserved", 0)).toBeUndefined();
  });
});
