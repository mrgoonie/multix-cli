import { describe, expect, it } from "vitest";
import { estimateCommand } from "../../../src/budget/command-cost.js";
import {
  type CostReceipt,
  buildCostReceipt,
  operationIdFor,
  settleOperations,
  settleReservation,
} from "../../../src/budget/cost-receipt.js";
import { extractUsage } from "../../../src/core/usage-extract.js";

const AT = new Date("2026-10-26T12:00:00Z");
const POST_OK = { method: "POST", status: 200 };
const GET_OK = { method: "GET", status: 200 };

describe("cost receipts", () => {
  it("nothing sent is a proven $0", () => {
    const r = buildCostReceipt({
      operation_id: "op",
      outcome: "not_sent",
      provider: "gemini",
      calls: [],
      at: AT,
    });
    expect(r).toMatchObject({
      status: "settled",
      actual_usd: 0,
      actual_source: "no_request",
      role: "none",
    });
  });

  it("keeps a provider-reported $0 as $0, and a missing cost as null", () => {
    const zero = buildCostReceipt({
      operation_id: "op",
      outcome: "ok",
      provider: "openrouter",
      calls: [POST_OK],
      usage: { cost_usd: 0 },
      at: AT,
    });
    expect(zero).toMatchObject({
      status: "settled",
      actual_usd: 0,
      actual_source: "provider_reported",
    });
    const missing = buildCostReceipt({
      operation_id: "op",
      outcome: "ok",
      provider: "openrouter",
      model: "some/model",
      calls: [POST_OK],
      at: AT,
    });
    expect(missing).toMatchObject({ status: "unknown", actual_usd: null, actual_source: null });
    expect(missing.provider_reported).toEqual({ cost_usd: null, credits: null });
  });

  it("keeps fractional credits", () => {
    const r = buildCostReceipt({
      operation_id: "op",
      outcome: "ok",
      provider: "leonardo",
      calls: [POST_OK],
      usage: { credits: 12.345678912 },
      at: AT,
    });
    expect(r.provider_reported.credits).toBe(12.345679);
    expect(r.actual_usd).toBeNull();
  });

  it("4xx after an accepted submit is uncertain, not $0", () => {
    const r = buildCostReceipt({
      operation_id: "fal:req-1",
      outcome: "failed",
      provider: "fal",
      calls: [POST_OK, { method: "GET", status: 422 }],
      at: AT,
    });
    expect(r).toMatchObject({ role: "charge", status: "uncertain", actual_usd: null });
  });

  it("a cut-off submit is uncertain", () => {
    const r = buildCostReceipt({
      operation_id: "op",
      outcome: "failed",
      provider: "fal",
      calls: [{ method: "POST", status: 0 }],
      at: AT,
    });
    expect(r.status).toBe("uncertain");
  });

  it("computes ElevenLabs actual from the character-cost header and reports variance", () => {
    const usage = extractUsage(undefined, new Headers({ "character-cost": "17" }));
    const estimate = estimateCommand("elevenlabs tts", { text: "Xin chào thế giới" }, { at: AT });
    const r = buildCostReceipt({
      operation_id: "op",
      outcome: "ok",
      provider: "elevenlabs",
      model: "eleven_multilingual_v2",
      calls: [POST_OK],
      usage: { credits: usage.credits, metrics: usage.metrics },
      estimate,
      at: AT,
    });
    expect(r).toMatchObject({ status: "computed", actual_source: "computed_from_usage" });
    expect(r.actual_usd).toBeCloseTo(0.00136, 9);
    expect(r.variance_usd).toBe(0);
    expect(r.measured).toEqual({ characters: 17 });
  });

  it("computes Gemini actual from Interactions usage (text tokens in, audio tokens out)", () => {
    const usage = extractUsage({ usage: { total_input_tokens: 20, total_output_tokens: 250 } });
    expect(usage.tokens).toMatchObject({ input: 20, output: 250 });
    const r = buildCostReceipt({
      operation_id: "op",
      outcome: "ok",
      provider: "gemini",
      model: "gemini-3.8-flash-tts",
      calls: [POST_OK],
      usage: { tokens: usage.tokens, metrics: usage.metrics },
      at: AT,
    });
    expect(r.actual_usd).toBeCloseTo((20 * 0.5 + 250 * 9) / 1e6, 9);
  });

  it("status-only runs are observations", () => {
    const r = buildCostReceipt({
      operation_id: "fal:req-1",
      outcome: "ok",
      provider: "fal",
      calls: [GET_OK],
      at: AT,
    });
    expect(r).toMatchObject({ role: "observation", status: "unknown" });
  });

  it("names the operation: explicit, then provider job id, then the run", () => {
    expect(
      operationIdFor({ explicit: " job:1 ", provider: "fal", providerIds: ["r"], runId: "h" }),
    ).toBe("job:1");
    expect(operationIdFor({ provider: "fal", providerIds: ["req-1"], runId: "h" })).toBe(
      "fal:req-1",
    );
    expect(operationIdFor({ provider: "gemini", providerIds: [], runId: "h_1" })).toBe("run:h_1");
  });
});

function receipt(over: Partial<CostReceipt>): CostReceipt {
  return {
    schema: "multix.cost/v1",
    operation_id: "op",
    role: "charge",
    status: "settled",
    currency: "USD",
    provider_reported: { cost_usd: null, credits: null },
    actual_usd: null,
    actual_source: null,
    variance_usd: null,
    at: AT.toISOString(),
    ...over,
  };
}

describe("settlement", () => {
  it("counts an operation once across submit, polls and replays", () => {
    const summary = settleOperations([
      receipt({ operation_id: "fal:1", status: "computed", actual_usd: 0.1 }),
      receipt({ operation_id: "fal:1", role: "observation", status: "unknown" }),
      receipt({ operation_id: "fal:1", role: "observation", status: "settled", actual_usd: 0.12 }),
      receipt({ operation_id: "fal:1", role: "observation", status: "settled", actual_usd: 0.12 }),
      receipt({ operation_id: "fal:2", status: "settled", actual_usd: 0.05 }),
    ]);
    expect(summary.total_usd).toBe(0.17);
    expect(summary.operations.find((o) => o.operation_id === "fal:1")).toMatchObject({
      status: "settled",
      actual_usd: 0.12,
      runs: 4,
    });
  });

  it("excludes uncertain operations from the total but counts them", () => {
    const summary = settleOperations([
      receipt({ operation_id: "a", status: "uncertain" }),
      receipt({ operation_id: "b", status: "settled", actual_usd: 0.2 }),
    ]);
    expect(summary).toMatchObject({ total_usd: 0.2, uncertain: 1 });
  });

  it("applies refunds once, even when replayed", () => {
    const refund = { operation_id: "a", kind: "refund" as const, usd: -0.05, at: AT.toISOString() };
    const summary = settleOperations(
      [receipt({ operation_id: "a", actual_usd: 0.2 })],
      [refund, refund],
    );
    expect(summary.total_usd).toBe(0.15);
  });

  it("releases a reservation by the actual and holds it while uncertain", () => {
    const reservation = {
      operation_id: "a",
      reserve_usd: 0.5,
      upper_bound: "proven" as const,
      policy: "strict",
      created_at: AT.toISOString(),
    };
    expect(settleReservation(reservation, receipt({ actual_usd: 0.2 }), AT)).toMatchObject({
      release_usd: 0.3,
      held: false,
    });
    expect(settleReservation(reservation, receipt({ status: "uncertain" }), AT)).toMatchObject({
      release_usd: 0,
      held: true,
    });
  });
});
