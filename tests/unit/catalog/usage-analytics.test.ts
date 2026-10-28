/**
 * Usage analytics over run ledger entries: polls and resumes of one job are
 * one operation, retries are attempts, spend counts each operation once, and
 * an operation with no cost is unknown rather than $0. Entries are built in
 * memory; no history file is read here.
 */

import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../../../src/agent/history-store.js";
import type { CostReceipt } from "../../../src/budget/cost-receipt.js";
import { sampleConfidence, usageReport } from "../../../src/catalog/usage-analytics.js";

let seq = 0;

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  seq++;
  return {
    v: 1,
    id: `h_test_${seq}`,
    ts: "2026-10-27T10:00:00.000Z",
    duration_ms: 2000,
    cwd: "/work",
    version: "0.0.0",
    command: "byteplus video",
    provider: "byteplus",
    model_resolved: "dreamina-seedance-2-0-260128",
    argv: ["byteplus", "video", "a cat"],
    ok: true,
    exit_code: 0,
    ...over,
  };
}

function receipt(over: Partial<CostReceipt> = {}): CostReceipt {
  return {
    schema: "multix.cost/v1",
    operation_id: "op-1",
    role: "charge",
    status: "settled",
    currency: "USD",
    provider_reported: { cost_usd: 0.5, credits: null },
    actual_usd: 0.5,
    actual_source: "provider_reported",
    variance_usd: null,
    at: "2026-10-27T10:00:05.000Z",
    ...over,
  };
}

describe("sampleConfidence", () => {
  it("sets the thresholds at 5, 20 and 100 operations", () => {
    expect(sampleConfidence(0)).toBe("insufficient");
    expect(sampleConfidence(4)).toBe("insufficient");
    expect(sampleConfidence(5)).toBe("low");
    expect(sampleConfidence(19)).toBe("low");
    expect(sampleConfidence(20)).toBe("medium");
    expect(sampleConfidence(99)).toBe("medium");
    expect(sampleConfidence(100)).toBe("high");
  });
});

describe("operations", () => {
  it("counts polls and resumes of one job as one operation with several runs", () => {
    const job = { provider: "byteplus", id: "task_1", attempt: 1 };
    const report = usageReport(
      [
        entry({ id: "h_submit", ts: "2026-10-27T10:00:00.000Z", job }),
        entry({ id: "h_poll_1", ts: "2026-10-27T10:00:10.000Z", job, command: "byteplus status" }),
        entry({ id: "h_poll_2", ts: "2026-10-27T10:00:20.000Z", job, command: "byteplus status" }),
      ],
      "model",
    );
    const row = report.rows[0];
    expect(report.rows).toHaveLength(1);
    expect(row).toMatchObject({
      operations: 1,
      runs: 3,
      attempts: 1,
      completed: 1,
      success_rate: 1,
    });
    expect(row?.sample).toEqual({ operations: 1, confidence: "insufficient" });
  });

  it("counts provider sends beyond the first as attempts, and reports the retry rate", () => {
    const report = usageReport(
      [
        entry({ id: "h_retry", job: { provider: "byteplus", id: "task_9", attempt: 3 } }),
        entry({ id: "h_other", job: { provider: "byteplus", id: "task_10", attempt: 1 } }),
      ],
      "model",
    );
    expect(report.rows[0]).toMatchObject({ operations: 2, attempts: 4, retry_rate: 0.5 });
    expect(report.totals).toMatchObject({ operations: 2, attempts: 4, retry_rate: 0.5 });
  });

  it("counts a failed run followed by a cancelled one as canceled, not failed", () => {
    const report = usageReport(
      [
        entry({
          id: "h_cancel",
          ok: false,
          exit_code: 1,
          error: { code: "CANCELLED", message: "cancelled by user" },
          job: { provider: "byteplus", id: "task_c", attempt: 1 },
        }),
        entry({
          id: "h_fail",
          ok: false,
          exit_code: 1,
          error: { code: "PROVIDER_ERROR", message: "boom" },
        }),
      ],
      "model",
    );
    expect(report.rows[0]).toMatchObject({
      operations: 2,
      completed: 0,
      canceled: 1,
      failed: 1,
      success_rate: 0,
    });
  });
});

describe("spend", () => {
  it("counts an operation once when two entries carry the same receipt operation id", () => {
    const shared = receipt({ operation_id: "op-shared" });
    const report = usageReport(
      [
        entry({ id: "h_a", cost: shared }),
        entry({ id: "h_b", cost: shared, ts: "2026-10-27T10:00:30.000Z" }),
      ],
      "model",
    );
    expect(report.rows[0]?.cost).toMatchObject({ actual_usd: 0.5, actual_ops: 1, unknown_ops: 0 });
    expect(report.totals.cost.actual_usd).toBe(0.5);
  });

  it("reports an estimate-only operation in estimated_usd, never as actual spend", () => {
    const estimated = receipt({
      operation_id: "op-est",
      status: "unknown",
      provider_reported: { cost_usd: null, credits: null },
      actual_usd: null,
      actual_source: null,
      estimate: {
        status: "estimated",
        low_usd: 0.2,
        expected_usd: 0.3,
        high_usd: 0.4,
        upper_bound: "none",
      } as unknown as CostReceipt["estimate"],
    });
    const report = usageReport([entry({ id: "h_est", cost: estimated })], "model");
    expect(report.rows[0]?.cost).toMatchObject({
      actual_usd: null,
      estimated_usd: 0.3,
      actual_ops: 0,
      estimated_only_ops: 1,
      unknown_ops: 0,
    });
    expect(report.rows[0]?.cost_per_success_usd).toBeNull();
  });

  it("reports an operation with no cost as unknown, with actual_usd null and not 0", () => {
    const report = usageReport([entry({ id: "h_nocost" })], "model");
    expect(report.rows[0]?.cost).toMatchObject({
      actual_usd: null,
      estimated_usd: null,
      actual_ops: 0,
      unknown_ops: 1,
    });
    expect(report.totals.cost.actual_usd).toBeNull();
  });

  it("treats a legacy entry's provider-reported cost as that run's actual spend", () => {
    const legacy = entry({
      id: "h_legacy",
      usage: { cost_usd: 0.25 },
    });
    const report = usageReport([legacy], "model");
    expect(report.rows[0]?.cost).toMatchObject({ actual_usd: 0.25, actual_ops: 1, unknown_ops: 0 });
  });

  it("gives cost per success only when every completed operation has a known cost", () => {
    const priced = usageReport(
      [
        entry({
          id: "h_p1",
          cost: receipt({ operation_id: "op-p1", at: "2026-10-27T10:00:05.000Z" }),
        }),
        entry({
          id: "h_p2",
          cost: receipt({
            operation_id: "op-p2",
            actual_usd: 1.5,
            provider_reported: { cost_usd: 1.5, credits: null },
            at: "2026-10-27T10:00:06.000Z",
          }),
        }),
      ],
      "model",
    );
    expect(priced.rows[0]).toMatchObject({ completed: 2, cost_per_success_usd: 1 });

    const partial = usageReport(
      [entry({ id: "h_q1", cost: receipt({ operation_id: "op-q1" }) }), entry({ id: "h_q2" })],
      "model",
    );
    expect(partial.rows[0]).toMatchObject({ completed: 2, cost_per_success_usd: null });
  });

  it("sums provider credits separately from USD", () => {
    const report = usageReport(
      [
        entry({ id: "h_c1", usage: { credits: 10 } }),
        entry({ id: "h_c2", usage: { credits: 2.5 } }),
      ],
      "model",
    );
    expect(report.rows[0]?.credits).toBe(12.5);
    expect(report.rows[0]?.cost.actual_usd).toBeNull();
  });
});

describe("model grouping", () => {
  it("keys a model by the model the provider resolved over the one requested", () => {
    const report = usageReport(
      [
        entry({ id: "h_r1", model_requested: "bytedance/seedance-2.0", model_resolved: null }),
        entry({
          id: "h_r2",
          model_requested: "bytedance/seedance-2.0",
          model_resolved: "dreamina-seedance-2-0-260128",
        }),
      ],
      "model",
    );
    expect(report.rows.map((r) => r.key).sort()).toEqual([
      "byteplus:bytedance/seedance-2.0",
      "byteplus:dreamina-seedance-2-0-260128",
    ]);
  });

  it("moves a whole operation to the model a later resume resolved", () => {
    const job = { provider: "byteplus", id: "task_resolve", attempt: 1 };
    const report = usageReport(
      [
        entry({
          id: "h_s",
          ts: "2026-10-27T10:00:00.000Z",
          job,
          model_requested: "bytedance/seedance-2.0",
          model_resolved: null,
          ok: false,
        }),
        entry({
          id: "h_w",
          ts: "2026-10-27T10:00:30.000Z",
          job,
          model_requested: "bytedance/seedance-2.0",
          model_resolved: "dreamina-seedance-2-0-260128",
          ok: true,
        }),
      ],
      "model",
    );
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      key: "byteplus:dreamina-seedance-2-0-260128",
      runs: 2,
      operations: 1,
      completed: 1,
    });
    expect(report.rows[0]?.model_identity).toEqual({ resolved: 1, requested_only: 1, missing: 0 });
  });
});

describe("filters and groups", () => {
  it("excludes dry runs and estimate-only entries from every count", () => {
    const report = usageReport(
      [
        entry({ id: "h_dry", dry_run: true }),
        entry({ id: "h_est", estimate_only: true, cost: receipt({ operation_id: "op-e" }) }),
      ],
      "model",
    );
    expect(report.rows).toEqual([]);
    expect(report.totals).toMatchObject({
      runs: 0,
      operations: 0,
      success_rate: null,
      latency_s: null,
    });
    expect(report.totals.cost.actual_usd).toBeNull();
  });

  it("groups by task through the command capability and by command as written", () => {
    const entries = [
      entry({ id: "h_t1", command: "byteplus video" }),
      entry({ id: "h_t2", command: "byteplus video" }),
      entry({ id: "h_t3", command: "no such command" }),
    ];
    const byTask = usageReport(entries, "task");
    expect(byTask.rows.map((r) => [r.key, r.runs])).toEqual([
      ["video", 2],
      ["(none)", 1],
    ]);
    const byCommand = usageReport(entries, "command");
    expect(byCommand.rows.map((r) => r.key)).toEqual(["byteplus video", "no such command"]);
  });

  it("omits model identity from the provider grouping and from totals", () => {
    const report = usageReport([entry({ id: "h_g" })], "provider");
    expect(report.rows[0]?.model_identity).toBeUndefined();
    expect(report.totals).not.toHaveProperty("model_identity");
    expect(report.scope).toBe("local-history");
  });

  it("reports latency as p50 and p95 in seconds", () => {
    const durations = [1000, 2000, 3000, 4000, 10000];
    const report = usageReport(
      durations.map((d, i) => entry({ id: `h_l${i}`, duration_ms: d })),
      "model",
    );
    expect(report.rows[0]?.latency_s).toEqual({ p50: 3, p95: 10 });
  });

  it("gives a confidence level from the operation count of each row", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      entry({ id: `h_many${i}`, job: { provider: "byteplus", id: `t${i}`, attempt: 1 } }),
    );
    const report = usageReport(many, "model");
    expect(report.rows[0]?.sample).toEqual({ operations: 5, confidence: "low" });
  });
});

describe("legacy receipts", () => {
  // A legacy receipt belongs to the job's operation, and the provider's figure is
  // the job total that every poll or resume reports again: count it once.
  it("counts a legacy run's cost once when the run is part of a job with several runs", () => {
    // Before receipts existed, each run carried the provider's cost_usd; a job
    // with a submit and a poll is one operation, so its cost is counted once.
    const job = { provider: "byteplus", id: "task_legacy", attempt: 1 };
    const report = usageReport(
      [
        entry({
          id: "h_leg_submit",
          ts: "2026-10-27T10:00:00.000Z",
          job,
          usage: { cost_usd: 0.25 },
        }),
        entry({
          id: "h_leg_poll",
          ts: "2026-10-27T10:00:20.000Z",
          job,
          usage: { cost_usd: 0.25 },
        }),
      ],
      "model",
    );
    expect(report.rows[0]?.operations).toBe(1);
    expect(report.rows[0]?.cost.actual_usd).toBe(0.25);
  });

  it("attributes a legacy job's cost to its operation, so it is not reported as unknown", () => {
    const job = { provider: "byteplus", id: "task_legacy_one", attempt: 1 };
    const report = usageReport(
      [entry({ id: "h_leg_one", job, usage: { cost_usd: 0.25 } })],
      "model",
    );
    expect(report.rows[0]?.cost).toMatchObject({
      actual_usd: 0.25,
      actual_ops: 1,
      unknown_ops: 0,
    });
    expect(report.rows[0]?.cost_per_success_usd).toBe(0.25);
  });
});

describe("an async job polled for its status", () => {
  it("stays under its model when the later status poll names none", () => {
    const job = { provider: "fal", id: "req_poll", attempt: 1 };
    const report = usageReport(
      [
        entry({
          command: "fal video",
          provider: "fal",
          model_resolved: "bytedance/seedance-2.0/text-to-video",
          job,
          ts: "2026-10-27T10:00:00.000Z",
        }),
        entry({
          command: "fal status",
          provider: "fal",
          model_resolved: undefined,
          job,
          ts: "2026-10-27T10:01:00.000Z",
        }),
      ],
      "model",
    );
    expect(report.rows.map((r) => [r.key, r.operations, r.runs])).toEqual([
      ["fal:bytedance/seedance-2.0/text-to-video", 1, 2],
    ]);
  });
});
