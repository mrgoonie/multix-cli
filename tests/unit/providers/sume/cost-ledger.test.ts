/**
 * Sume's reservation ledger as multix cost: a hold is never spend, a final
 * ledger is the settled charge (or a $0 refund), and an operation is counted
 * once across the submit run and any resume run.
 */

import { afterEach, describe, expect, it } from "vitest";
import { installFetchTelemetry, settleTelemetry } from "../../../../src/agent/fetch-telemetry.js";
import { run, summarizeUsage } from "../../../../src/agent/run-state.js";
import { buildCostReceipt, settleOperations } from "../../../../src/budget/cost-receipt.js";
import { extractUsage } from "../../../../src/core/usage-extract.js";
import { SumeClient } from "../../../../src/providers/sume/client.js";
import { fakeSume, job, json } from "./fake-sume.js";

const HOLD = {
  status: "reserved",
  reserved_credits: 560,
  reserved_usd_cents: 56,
  captured_credits: 0,
  final: false,
};
const CAPTURED = {
  status: "captured",
  reserved_credits: 560,
  captured_credits: 560,
  captured_usd_cents: 56,
  refunded_usd_cents: 0,
  final: true,
};
const REFUNDED = {
  status: "refunded",
  reserved_credits: 560,
  captured_credits: 0,
  captured_usd_cents: 0,
  refunded_credits: 560,
  refunded_usd_cents: 56,
  final: true,
};

describe("ledger extraction", () => {
  it("never reads the submit's hold as spend", () => {
    const u = extractUsage({
      data: {
        job: job("job_1", "queued", HOLD),
        status_url: "/v1/jobs/job_1/status",
        usage: { credits: 560, usd: "0.56" },
      },
    });
    expect(u.cost_usd).toBeUndefined();
    expect(u.credits).toBeUndefined();
    expect(u.ids).toContain("job_1");
  });

  it("reads a final captured ledger as the charge", () => {
    const u = extractUsage({ data: { job: job("job_1", "completed", CAPTURED) } });
    expect(u.cost_usd).toBe(0.56);
    expect(u.credits).toBe(560);
    expect(u.sources?.cost_usd).toBe("body.data.job.usage_summary.captured_usd_cents");
  });

  it("reads a refunded ledger as a proven $0", () => {
    const u = extractUsage({ data: { job: job("job_1", "failed", REFUNDED) } });
    expect(u.cost_usd).toBe(0);
  });

  it("reports nothing for a pending or missing ledger", () => {
    expect(extractUsage({ data: { job: job("job_1", "processing", null) } }).cost_usd).toBe(
      undefined,
    );
    expect(extractUsage({ data: { job: job("job_1", "processing", HOLD) } }).cost_usd).toBe(
      undefined,
    );
  });
});

const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
  run.postUsage = [];
  run.getUsage = new Map();
  run.calls = [];
  run.ids = [];
  run.idCalls = new Map();
  run.requestModel = undefined;
});

describe("a submit run through the fetch telemetry", () => {
  it("settles to the captured charge once, not the hold plus the charge", async () => {
    const { fetch } = fakeSume({
      "POST /v1/video-router/generate": [
        json(
          {
            data: {
              job: job("job_1", "queued", HOLD),
              status_url: "/v1/jobs/job_1/status",
              usage: { credits: 560, usd: "0.56" },
            },
          },
          202,
        ),
      ],
      "GET /v1/jobs/job_1/status": [
        json({ data: { job_id: "job_1", sume_status: "completed", terminal: true } }),
      ],
      "GET /v1/jobs/job_1": [json({ data: { job: job("job_1", "completed", CAPTURED) } })],
    });
    globalThis.fetch = fetch;
    installFetchTelemetry(() => {
      throw new Error("not a dry run");
    });
    const client = new SumeClient({ apiKey: "k" });
    await client.submit("video", { model: "kling-3", prompt: "x" }, "key-1");
    await client.getStatus("job_1");
    await client.getJob("job_1");
    await settleTelemetry();
    const usage = summarizeUsage();
    expect(usage?.cost_usd).toBe(0.56);
    expect(usage?.credits).toBe(560);
  });
});

describe("operations across runs", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 28, 0, 0, s));
  const submitRun = (cost: number | undefined, outcome: "ok" | "failed", s: number) =>
    buildCostReceipt({
      operation_id: "sume:job_1",
      outcome,
      provider: "sume",
      calls: [
        { method: "POST", status: 202 },
        { method: "GET", status: 200 },
      ],
      usage: cost === undefined ? undefined : { cost_usd: cost },
      at: at(s),
    });
  const resumeRun = (cost: number, s: number) =>
    buildCostReceipt({
      operation_id: "sume:job_1",
      outcome: "ok",
      provider: "sume",
      calls: [{ method: "GET", status: 200 }],
      usage: { cost_usd: cost },
      at: at(s),
    });

  it("counts a job once when an interrupted submit is resumed", () => {
    // The submit run stopped while polling: it saw no final ledger.
    const summary = settleOperations([submitRun(undefined, "failed", 1), resumeRun(0.56, 2)]);
    expect(summary.total_usd).toBe(0.56);
    expect(summary.operations).toHaveLength(1);
    expect(summary.operations[0]?.status).toBe("settled");
  });

  it("does not double-count a completed job read again later", () => {
    const summary = settleOperations([submitRun(0.56, "ok", 1), resumeRun(0.56, 2)]);
    expect(summary.total_usd).toBe(0.56);
  });

  it("settles a failed, refunded job at $0", () => {
    const summary = settleOperations([submitRun(0, "failed", 1), resumeRun(0, 2)]);
    expect(summary.total_usd).toBe(0);
    expect(summary.operations[0]?.actual_usd).toBe(0);
  });

  it("leaves an interrupted submit without a ledger uncertain, not $0", () => {
    const summary = settleOperations([submitRun(undefined, "failed", 1)]);
    expect(summary.operations[0]?.actual_usd).toBeNull();
    expect(summary.uncertain + summary.unknown).toBe(1);
  });
});
