/**
 * What a Sume run reports as spent: the submit's usage.usd (a decimal string)
 * counts once; polls, reserved / refunded / released amounts and the balance
 * never count as spend. Runs the real client through the CLI fetch telemetry.
 */

import { afterEach, describe, expect, it } from "vitest";
import { installFetchTelemetry, settleTelemetry } from "../../../../src/agent/fetch-telemetry.js";
import { run, summarizeUsage } from "../../../../src/agent/run-state.js";
import { buildCostReceipt } from "../../../../src/budget/cost-receipt.js";
import { extractUsage } from "../../../../src/core/usage-extract.js";
import { SumeClient } from "../../../../src/providers/sume/client.js";
import {
  BASE,
  JOB_ID,
  KEY,
  createFakeSume,
  noSleep,
  result,
  status,
  submitted,
} from "./fake-sume.js";

const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
  run.postUsage = [];
  run.getUsage = new Map();
  run.calls = [];
  run.ids = [];
  run.idCalls = new Map();
  run.requestModel = undefined;
  run.resolvedModel = undefined;
  run.dryRun = false;
});

const RESERVED_SUMMARY = {
  usage_summary: {
    reserved_credits: 35,
    reserved_usd: "0.35",
    refunded_credits: 0,
    released_credits: 0,
  },
};

function client(routes: Parameters<typeof createFakeSume>[0]) {
  const fake = createFakeSume(routes);
  globalThis.fetch = fake.fetch as typeof fetch;
  installFetchTelemetry(() => {
    throw new Error("not a dry run");
  });
  return new SumeClient({ apiKey: KEY, baseUrl: BASE, sleep: noSleep });
}

function receipt(outcome: "ok" | "failed" = "ok") {
  return buildCostReceipt({
    operation_id: "op",
    outcome,
    provider: "sume",
    model: "nano-banana-2.1",
    calls: run.calls,
    usage: summarizeUsage(),
  });
}

describe("usage extraction", () => {
  it("reads usage.usd as a decimal string, and nothing else as a string amount", () => {
    expect(extractUsage(submitted())).toMatchObject({
      cost_usd: 0.35,
      credits: 35,
      sources: { cost_usd: "body.data.usage.usd", credits: "body.data.usage.credits" },
    });
    expect(extractUsage({ data: { usd: "0.35" } }).cost_usd).toBeUndefined();
    expect(extractUsage({ data: { usage: { usd: "1e3" } } }).cost_usd).toBeUndefined();
    expect(extractUsage({ data: { usage: { usd: "about 2" } } }).cost_usd).toBeUndefined();
  });

  it("never counts reserved, refunded or released amounts", () => {
    const usage = extractUsage({ data: { job: { id: JOB_ID, ...RESERVED_SUMMARY } } });
    expect(usage.cost_usd).toBeUndefined();
    expect(usage.credits).toBeUndefined();
  });

  it("never counts the balance", () => {
    const usage = extractUsage({
      data: { balance: 12.5, currency: "USD", balance_usd_micros: 12_500_000 },
    });
    expect(usage.cost_usd).toBeUndefined();
    expect(usage.credits).toBeUndefined();
  });
});

describe("cost receipt of a Sume run", () => {
  it("settles at the submit's usage.usd, counted once across submit, polls and result", async () => {
    const sume = client({
      "POST /v1/image-router/generate": [{ status: 202, json: submitted() }],
      [`GET /v1/jobs/${JOB_ID}/status`]: [
        { json: status("processing", RESERVED_SUMMARY) },
        { json: status("completed", RESERVED_SUMMARY) },
      ],
      [`GET /v1/jobs/${JOB_ID}/result`]: [{ json: result() }],
    });
    const job = await sume.generate("image", { model: "nano-banana-2.1", prompt: "x" });
    await sume.waitForJob(job.jobId, { timeoutMs: 60_000 });
    await sume.getResult(job.jobId);
    await settleTelemetry();

    expect(run.calls.map((c) => `${c.method} ${c.status}`)).toEqual([
      "POST 202",
      "GET 200",
      "GET 200",
      "GET 200",
    ]);
    expect(summarizeUsage()).toMatchObject({ cost_usd: 0.35, credits: 35 });
    expect(receipt()).toMatchObject({
      role: "charge",
      status: "settled",
      actual_usd: 0.35,
      actual_source: "provider_reported",
      provider_reported: { cost_usd: 0.35, credits: 35 },
    });
  });

  it("does not report a balance check as spend", async () => {
    const sume = client({
      "GET /v1/open/balance": [
        { json: { data: { balance: 9.65, currency: "USD", usage_this_month: 0.35 } } },
      ],
    });
    expect(await sume.balance()).toMatchObject({ balance: 9.65 });
    await settleTelemetry();
    expect(summarizeUsage()?.cost_usd).toBeUndefined();
    expect(receipt()).toMatchObject({ role: "observation", actual_usd: null });
  });

  it("leaves a cut-off submit uncertain rather than free", async () => {
    const sume = client({
      "POST /v1/image-router/generate": [
        { status: 503, text: "unavailable", headers: { "retry-after": "0" } },
      ],
    });
    await expect(sume.generate("image", { model: "nano-banana-2.1", prompt: "x" })).rejects.toThrow(
      /--idempotency-key/,
    );
    await settleTelemetry();
    expect(receipt("failed")).toMatchObject({ status: "uncertain", actual_usd: null });
  });
});

describe("decimal-string amounts", () => {
  it.each([["1e3"], ["-1"], ["0.35 USD"], [" 0.35"], ["0x10"], [""]])(
    "ignores %j, which is not a plain decimal",
    (value) => {
      expect(extractUsage({ usage: { usd: value } }).cost_usd).toBeUndefined();
    },
  );

  it("ignores decimal strings under keys that name no money, or an id", () => {
    const usage = extractUsage({ usage: { seed: "12", credit_id: "42", model_version: "3.1" } });
    expect(usage.credits).toBeUndefined();
    expect(usage.cost_usd).toBeUndefined();
    expect(usage.metrics).toEqual({});
  });

  it("does not count an amount whose billing_state is not captured", () => {
    for (const state of ["RESERVED", "RELEASED", "REFUNDED"]) {
      const usage = extractUsage({ data: { charged_usd: "0.40", billing_state: state } });
      expect(usage.cost_usd).toBeUndefined();
    }
  });
});
