/**
 * What a Sume run reports as spent: the captured charge of a completed job
 * (usage_summary.captured_usd_cents), counted once. The submit's usage.usd is a
 * reservation and never counts; refunded jobs record nothing; reserved /
 * refunded / released amounts and the balance never count as spend. Runs the real client through the CLI fetch telemetry.
 */

import { afterEach, describe, expect, it } from "vitest";
import { installFetchTelemetry, settleTelemetry } from "../../../../src/agent/fetch-telemetry.js";
import { run, summarizeUsage } from "../../../../src/agent/run-state.js";
import { checkBudget, estimateCommand } from "../../../../src/budget/command-cost.js";
import { buildCostReceipt, settleOperations } from "../../../../src/budget/cost-receipt.js";
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
  run.postAmountsReserved = undefined;
});

/** A job's usage_summary while the reservation is held (documented field names, USD in cents). */
const RESERVED_SUMMARY = {
  usage_summary: {
    status: "reserved",
    reserved_credits: 35,
    reserved_usd_cents: 35,
    captured_credits: 0,
    captured_usd_cents: 0,
    refunded_credits: 0,
    refunded_usd_cents: 0,
    released_credits: 0,
    released_usd_cents: 0,
    final: false,
  },
};

function jobBody(state: string, summary: Record<string, unknown>) {
  return { data: { job: { id: JOB_ID, status: state, usage_summary: summary } } };
}

const CAPTURED = jobBody("completed", {
  status: "captured",
  reserved_usd_cents: 35,
  captured_credits: 35,
  captured_usd_cents: 35,
  refunded_usd_cents: 0,
  final: true,
});

function refunded(state: "failed" | "canceled") {
  return jobBody(state, {
    status: "refunded",
    reserved_usd_cents: 35,
    captured_credits: 0,
    captured_usd_cents: 0,
    refunded_credits: 35,
    refunded_usd_cents: 35,
    final: true,
  });
}

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
  /** A `sume image` run: the submit's usage is a reservation, never spend. */
  function generationClient(routes: Parameters<typeof createFakeSume>[0]) {
    const sume = client({
      "POST /v1/image-router/generate": [{ status: 202, json: submitted() }],
      ...routes,
    });
    run.postAmountsReserved = true;
    return sume;
  }

  it("settles a completed job at its captured charge, counted once", async () => {
    const sume = generationClient({
      [`GET /v1/jobs/${JOB_ID}/status`]: [
        { json: status("processing", RESERVED_SUMMARY) },
        { json: status("completed") },
      ],
      [`GET /v1/jobs/${JOB_ID}`]: [{ json: CAPTURED }],
      [`GET /v1/jobs/${JOB_ID}/result`]: [{ json: result() }],
    });
    const job = await sume.generate("image", { model: "nano-banana-2.1", prompt: "x" });
    await sume.waitForJob(job.jobId, { timeoutMs: 60_000 });
    expect((await sume.getJob(job.jobId)).charge).toEqual({
      status: "captured",
      capturedUsd: 0.35,
    });
    await sume.getResult(job.jobId);
    await settleTelemetry();

    expect(summarizeUsage()).toMatchObject({ cost_usd: 0.35, credits: 35 });
    expect(summarizeUsage()?.metrics?.["data.usage.usd"]).toBe(0.35);
    expect(receipt()).toMatchObject({
      role: "charge",
      status: "settled",
      actual_usd: 0.35,
      actual_source: "provider_reported",
      provider_reported: { cost_usd: 0.35, credits: 35 },
    });
  });

  it("counts one job's charge once when several GET paths report it", async () => {
    const summary = {
      usage_summary: { status: "captured", captured_credits: 1, captured_usd_cents: 1 },
    };
    const sume = client({
      [`GET /v1/jobs/${JOB_ID}/status`]: [{ json: status("completed", summary) }],
      [`GET /v1/jobs/${JOB_ID}`]: [{ json: jobBody("completed", summary.usage_summary) }],
      [`GET /v1/jobs/${JOB_ID}/result`]: [{ json: { data: { ...result().data, ...summary } } }],
    });
    await sume.getStatus(JOB_ID);
    await sume.getJob(JOB_ID);
    await sume.getResult(JOB_ID);
    await settleTelemetry();

    expect(summarizeUsage()).toMatchObject({ cost_usd: 0.01, credits: 1 });
  });

  it("still adds up the charges of different jobs read in one run", async () => {
    const other = "job_9f9e9d9c-1111-4222-8333-444455556666";
    const captured = (id: string, cents: number) => ({
      data: {
        job: {
          id,
          status: "completed",
          usage_summary: { status: "captured", captured_credits: cents, captured_usd_cents: cents },
        },
      },
    });
    const sume = client({
      [`GET /v1/jobs/${JOB_ID}`]: [{ json: captured(JOB_ID, 1) }],
      [`GET /v1/jobs/${other}`]: [{ json: captured(other, 2) }],
    });
    await sume.getJob(JOB_ID);
    await sume.getJob(other);
    await settleTelemetry();

    expect(summarizeUsage()).toMatchObject({ cost_usd: 0.03, credits: 3 });
  });

  it.each([["failed" as const], ["canceled" as const]])(
    "records no spend for a %s job whose reservation was refunded",
    async (state) => {
      const sume = generationClient({
        [`GET /v1/jobs/${JOB_ID}/status`]: [{ json: status(state) }],
        [`GET /v1/jobs/${JOB_ID}`]: [{ json: refunded(state) }],
      });
      const job = await sume.generate("image", { model: "nano-banana-2.1", prompt: "x" });
      await sume.waitForJob(job.jobId, { timeoutMs: 60_000 });
      await sume.getJob(job.jobId);
      await settleTelemetry();

      expect(summarizeUsage()?.cost_usd).toBe(0);
      expect(receipt("failed")).toMatchObject({ status: "settled", actual_usd: 0 });
    },
  );

  it("leaves a submit-only run's cost unknown, not settled at the reservation", async () => {
    const sume = generationClient({});
    await sume.generate("image", { model: "nano-banana-2.1", prompt: "x" });
    await settleTelemetry();

    expect(summarizeUsage()?.cost_usd).toBeUndefined();
    expect(summarizeUsage()?.credits).toBeUndefined();
    expect(summarizeUsage()?.metrics?.["data.usage.usd"]).toBe(0.35);
    const r = receipt();
    expect(r).toMatchObject({ role: "charge", actual_usd: null, actual_source: null });
    expect(["unknown", "uncertain"]).toContain(r.status);
  });

  it("does not count a job still holding its reservation", async () => {
    const sume = generationClient({
      [`GET /v1/jobs/${JOB_ID}`]: [{ json: jobBody("processing", RESERVED_SUMMARY.usage_summary) }],
    });
    await sume.generate("image", { model: "nano-banana-2.1", prompt: "x" });
    await sume.getJob(JOB_ID);
    await settleTelemetry();
    expect(summarizeUsage()?.cost_usd).toBeUndefined();
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

describe("sume estimate, a free quote", () => {
  it("is priced at a proven $0, so --max-cost lets it through", () => {
    const estimate = estimateCommand("sume estimate", { model: "veo-3.1" });
    expect(estimate).toMatchObject({ status: "estimated", high_usd: 0, upper_bound: "proven" });
    expect(() => checkBudget(estimate, 0, "strict")).not.toThrow();
  });

  it("gets an observation receipt that adds no unknown-cost operation", () => {
    const quote = buildCostReceipt({
      operation_id: "run:h_1",
      outcome: "ok",
      provider: "sume",
      calls: [{ method: "POST", status: 200 }],
      free: true,
    });
    expect(quote).toMatchObject({ role: "observation", actual_usd: null });
    expect(settleOperations([quote])).toMatchObject({ operations: [], unknown: 0 });

    const charge = buildCostReceipt({
      operation_id: "run:h_2",
      outcome: "ok",
      provider: "sume",
      calls: [{ method: "POST", status: 200 }],
    });
    expect(charge.role).toBe("charge");
  });
});
