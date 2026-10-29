/**
 * Usage aggregation over the run ledger: what counts as a request, an
 * operation, a retry or a cancel, and how spend is known, unknown or uncertain.
 */

import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../../../src/agent/history-store.js";
import type { CostReceipt } from "../../../src/budget/cost-receipt.js";
import {
  USAGE_GROUPS,
  aggregateUsage,
  confidence,
  operationOf,
} from "../../../src/catalog/usage-aggregate.js";

const T0 = "2026-10-27T10:00:00.000Z";

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    v: 1,
    id: `h_${Math.random().toString(36).slice(2, 10)}`,
    ts: T0,
    duration_ms: 1000,
    cwd: "/tmp",
    version: "0.0.0",
    command: "fal video",
    provider: "fal",
    argv: ["fal", "video"],
    ok: true,
    exit_code: 0,
    model_resolved: "bytedance/seedance-2.5/text-to-video",
    // One recorded HTTP call: the proof of a send for a run without a receipt.
    http: { requests: 1, errors: 0, ms: 1000 },
    ...over,
  };
}

function receipt(over: Partial<CostReceipt> & Pick<CostReceipt, "operation_id">): CostReceipt {
  return {
    schema: "multix.cost/v1",
    role: "charge",
    status: "settled",
    currency: "USD",
    provider_reported: { cost_usd: null, credits: null },
    actual_usd: null,
    actual_source: null,
    variance_usd: null,
    at: T0,
    ...over,
  };
}

const OFFERING = "fal:bytedance/seedance-2.5/text-to-video";

/** The one row of the offering grouping, or a failure that names what was there. */
function rowFor(entries: HistoryEntry[], key = OFFERING) {
  const row = aggregateUsage(entries, "offering").find((r) => r.key === key);
  if (!row) throw new Error(`no usage row ${key}`);
  return row;
}

describe("what counts as a request", () => {
  it("leaves out dry runs and estimate-only runs", () => {
    const rows = aggregateUsage(
      [entry({ dry_run: true }), entry({ estimate_only: true }), entry({})],
      "offering",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requests).toBe(1);
  });

  it("leaves out a successful run whose receipt says no request was sent", () => {
    const row = rowFor([
      entry({
        id: "h_none",
        http: { requests: 0, errors: 0, ms: 0 },
        cost: receipt({
          operation_id: "run:h_none",
          role: "none",
          actual_usd: 0,
          actual_source: "no_request",
        }),
      }),
      entry({}),
    ]);
    expect(row).toMatchObject({ requests: 1, operations: 1, completed: 1 });
  });

  it("counts a successful run without a receipt only when it made HTTP calls or got provider ids", () => {
    const rows = aggregateUsage(
      [
        entry({ http: undefined }),
        entry({ http: { requests: 0, errors: 0, ms: 0 } }),
        entry({ http: undefined, provider_ids: ["req-1"] }),
        entry({}),
      ],
      "offering",
    );
    expect(rows.map((r) => [r.key, r.requests])).toEqual([[OFFERING, 2]]);
  });

  it("counts a failed run with a receipt that sent something even without recorded HTTP calls", () => {
    const row = rowFor([
      entry({
        ok: false,
        exit_code: 1,
        error: { code: "NETWORK_ERROR", message: "cut" },
        http: undefined,
        cost: receipt({ operation_id: "op-f", role: "charge", status: "uncertain" }),
      }),
    ]);
    expect(row).toMatchObject({ requests: 1, operations: 1, failed: 1 });
  });

  it("sorts the busiest group first and breaks ties by key", () => {
    const rows = aggregateUsage(
      [
        entry({ provider: "fal", model_resolved: "b" }),
        entry({ provider: "fal", model_resolved: "a" }),
        entry({ provider: "fal", model_resolved: "a" }),
      ],
      "offering",
    );
    expect(rows.map((r) => [r.key, r.requests])).toEqual([
      ["fal:a", 2],
      ["fal:b", 1],
    ]);
  });
});

describe("operations, polls and resumes", () => {
  it("counts a submit, its polls and a resume that share a receipt operation id as one operation", () => {
    const op = "op-job-1";
    const entries = [
      entry({
        id: "h_submit",
        job: { provider: "fal", id: "job-1", attempt: 1 },
        cost: receipt({
          operation_id: op,
          role: "charge",
          status: "settled",
          actual_usd: 0.5,
          actual_source: "provider_reported",
          provider_reported: { cost_usd: 0.5, credits: null },
        }),
      }),
      entry({
        id: "h_poll",
        ts: "2026-10-27T10:01:00.000Z",
        job: { provider: "fal", id: "job-1", attempt: 1 },
        cost: receipt({ operation_id: op, role: "observation", status: "unknown" }),
      }),
      entry({
        id: "h_resume",
        ts: "2026-10-27T10:02:00.000Z",
        job: { provider: "fal", id: "job-1", attempt: 1 },
        cost: receipt({
          operation_id: op,
          role: "none",
          status: "settled",
          actual_source: "no_request",
        }),
      }),
    ];
    const row = rowFor(entries);
    // The resume read local state only (role "none"): not a request, still the same operation.
    expect(row.requests).toBe(2);
    expect(row.operations).toBe(1);
    expect(row.cost.known_usd).toBe(0.5);
    expect(row.cost.per_success_usd).toBe(0.5);
  });

  it("counts status reads of one job as one operation when the ledger has no receipt for them", () => {
    const job = { provider: "fal", id: "job-2", attempt: 1 };
    const rows = [
      entry({ job }),
      entry({ job, ts: "2026-10-27T10:01:00.000Z" }),
      entry({ job: { ...job, id: "job-3" } }),
    ];
    expect(rowFor(rows).operations).toBe(2);
    expect(operationOf(rows[0] as HistoryEntry)).toBe("job:fal:job-2");
  });

  it("gives a run with no job and no receipt its own operation", () => {
    const e = entry({ id: "h_solo" });
    expect(operationOf(e)).toBe("run:h_solo");
    expect(rowFor([e, entry({ id: "h_other" })]).operations).toBe(2);
  });
});

describe("retries, failures and cancels", () => {
  it("counts retries as failed sends before the one that returned the job (attempt minus one)", () => {
    const rows = [
      entry({ job: { provider: "fal", id: "job-r", attempt: 3 } }),
      entry({ job: { provider: "fal", id: "job-r", attempt: 1 }, ts: "2026-10-27T10:01:00.000Z" }),
      entry({ ok: false, exit_code: 1, error: { code: "PROVIDER_UNAVAILABLE", message: "down" } }),
    ];
    expect(rowFor(rows).retries).toBe(2);
  });

  it("counts a cancel separately from a failure, and both as requests", () => {
    const rows = [
      entry({
        ok: false,
        exit_code: 1,
        error: { code: "CANCELLED", message: "stopped" },
        http: { requests: 2, errors: 0, ms: 900 },
      }),
      entry({
        ok: false,
        exit_code: 1,
        error: { code: "PROVIDER_UNAVAILABLE", message: "down" },
        http: { requests: 1, errors: 1, ms: 300 },
      }),
      entry({}),
    ];
    const row = rowFor(rows);
    expect(row).toMatchObject({ requests: 3, completed: 1, failed: 1, canceled: 1 });
    expect(row.success_rate).toBeCloseTo(1 / 3, 3);
  });

  it("leaves out a failed run that never reached the provider (missing key, bad flag)", () => {
    const rows = [
      entry({
        ok: false,
        exit_code: 2,
        error: { code: "MISSING_KEY", message: "no key" },
        http: undefined,
      }),
      entry({
        ok: false,
        exit_code: 1,
        error: { code: "VALIDATION", message: "bad" },
        http: { requests: 0, errors: 0, ms: 0 },
      }),
      entry({}),
    ];
    expect(rowFor(rows)).toMatchObject({ requests: 1, completed: 1, failed: 0 });
  });

  it("counts a job whose status poll failed but which then completed as one completed operation", () => {
    const op = "fal:J1";
    const at = (m: number) => `2026-10-27T10:0${m}:00.000Z`;
    const rows = [
      entry({
        ts: at(0),
        provider_ids: ["J1"],
        cost: receipt({
          operation_id: op,
          actual_usd: 0.56,
          actual_source: "provider_reported",
          provider_reported: { cost_usd: 0.56, credits: null },
        }),
      }),
      entry({
        ts: at(1),
        ok: false,
        exit_code: 1,
        error: { code: "NETWORK_ERROR", message: "poll cut off" },
        cost: receipt({ operation_id: op, role: "observation", status: "unknown" }),
      }),
      entry({
        ts: at(2),
        cost: receipt({ operation_id: op, role: "observation", status: "unknown" }),
      }),
      entry({
        ts: at(3),
        cost: receipt({ operation_id: op, role: "observation", status: "unknown" }),
      }),
    ];
    const row = rowFor(rows);
    expect(row).toMatchObject({ requests: 4, operations: 1, completed: 1, failed: 0, canceled: 0 });
    expect(row.success_rate).toBe(1);
    expect(row.sample).toEqual({ n: 1, confidence: "low" });
  });

  it("decides an operation with no successful run by its latest run", () => {
    const fail = { ok: false, exit_code: 1 } as const;
    const down = { code: "PROVIDER_UNAVAILABLE", message: "down" };
    const cancel = { code: "CANCELLED", message: "stopped" };
    const job = (id: string) => ({ provider: "fal", id, attempt: 1 });
    const rows = [
      // Failed, then canceled on resume: canceled.
      entry({ ...fail, job: job("a"), ts: "2026-10-27T10:00:00.000Z", error: down }),
      entry({ ...fail, job: job("a"), ts: "2026-10-27T10:05:00.000Z", error: cancel }),
      // Canceled, then failed on resume (ledger out of time order): failed.
      entry({ ...fail, job: job("b"), ts: "2026-10-27T10:05:00.000Z", error: down }),
      entry({ ...fail, job: job("b"), ts: "2026-10-27T10:00:00.000Z", error: cancel }),
    ];
    const row = rowFor(rows);
    expect(row).toMatchObject({ requests: 4, operations: 2, completed: 0, failed: 1, canceled: 1 });
    expect(row.success_rate).toBe(0);
  });

  it("does not report a failed poll as a failure in another row when its job completed", () => {
    // Status reads carry no resolved model and a different command than the submit.
    const entries = [
      entry({
        provider_ids: ["J1"],
        cost: receipt({
          operation_id: "fal:J1",
          actual_usd: 0.56,
          actual_source: "provider_reported",
          provider_reported: { cost_usd: 0.56, credits: null },
        }),
      }),
      entry({
        ts: "2026-10-27T10:01:00.000Z",
        command: "fal status",
        model_resolved: undefined,
        ok: false,
        exit_code: 1,
        error: { code: "NETWORK_ERROR", message: "poll cut off" },
        cost: receipt({ operation_id: "fal:J1", role: "observation", status: "unknown" }),
      }),
    ];
    for (const by of USAGE_GROUPS) {
      const rows = aggregateUsage(entries, by);
      expect(
        rows.reduce((n, r) => n + r.requests, 0),
        by,
      ).toBe(2);
      for (const r of rows) {
        expect(r, `${by} ${r.key}`).toMatchObject({ failed: 0, canceled: 0, success_rate: 1 });
        expect(r.completed, `${by} ${r.key}`).toBe(r.operations);
      }
    }
  });

  it("still counts a failed poll recorded under its own run id as a failed operation (#424)", () => {
    // A poll whose first request failed captures no provider id, so its receipt names
    // the run, not the job. Operation identity across runs is tracked in #424.
    const entries = [
      entry({
        provider_ids: ["J1"],
        cost: receipt({
          operation_id: "fal:J1",
          actual_usd: 0.56,
          actual_source: "provider_reported",
        }),
      }),
      entry({
        id: "h_poll",
        ts: "2026-10-27T10:01:00.000Z",
        ok: false,
        exit_code: 1,
        error: { code: "NETWORK_ERROR", message: "poll cut off" },
        cost: receipt({ operation_id: "run:h_poll", role: "observation", status: "unknown" }),
      }),
    ];
    expect(rowFor(entries)).toMatchObject({
      requests: 2,
      operations: 2,
      completed: 1,
      failed: 1,
      success_rate: 0.5,
    });
  });

  it("fails a job whose status run reports JOB_FAILED even though its submit was accepted", () => {
    const op = "fal:req_1";
    const entries = [
      entry({ provider_ids: ["req_1"], cost: receipt({ operation_id: op }) }),
      entry({
        ts: "2026-10-27T10:01:00.000Z",
        command: "fal status",
        model_resolved: undefined,
        provider_ids: ["req_1"],
        ok: false,
        exit_code: 5,
        error: { code: "JOB_FAILED", message: "the provider failed the job" },
        cost: receipt({ operation_id: op, role: "observation", status: "unknown" }),
      }),
    ];
    for (const by of USAGE_GROUPS) {
      for (const r of aggregateUsage(entries, by)) {
        expect(r, `${by} ${r.key}`).toMatchObject({ completed: 0, canceled: 0, success_rate: 0 });
        expect(r.failed, `${by} ${r.key}`).toBe(r.operations);
      }
    }
    expect(aggregateUsage(entries, "provider")).toMatchObject([
      { key: "fal", requests: 2, operations: 1, completed: 0, failed: 1, success_rate: 0 },
    ]);
  });

  it("fails a job identified by its job record when a later run reports JOB_FAILED", () => {
    const job = { provider: "fal", id: "j-f", attempt: 1 };
    const row = rowFor([
      entry({ job }),
      entry({
        job,
        ts: "2026-10-27T10:05:00.000Z",
        ok: false,
        exit_code: 5,
        error: { code: "JOB_FAILED", message: "the provider failed the job" },
      }),
    ]);
    expect(row).toMatchObject({ operations: 1, completed: 0, failed: 1, success_rate: 0 });
  });

  it("keeps a job failed when a later read-only status poll exits ok", () => {
    const job = { provider: "byteplus", id: "j-r", attempt: 1 };
    const row = rowFor([
      entry({ job }),
      entry({
        job,
        ts: "2026-10-27T10:01:00.000Z",
        ok: false,
        exit_code: 5,
        error: { code: "JOB_FAILED", message: "the provider failed the job" },
      }),
      entry({ job, ts: "2026-10-27T10:05:00.000Z" }),
    ]);
    expect(row).toMatchObject({ operations: 1, completed: 0, failed: 1, success_rate: 0 });
  });

  it("completes an operation when a resubmit under the same operation id returned another job that succeeded", () => {
    const op = "agent-op-1";
    const row = rowFor([
      entry({ provider_ids: ["J1"], cost: receipt({ operation_id: op }) }),
      entry({
        ts: "2026-10-27T10:01:00.000Z",
        provider_ids: ["J1"],
        ok: false,
        exit_code: 5,
        error: { code: "JOB_FAILED", message: "the provider failed the job" },
        cost: receipt({ operation_id: op, role: "observation", status: "unknown" }),
      }),
      entry({
        ts: "2026-10-27T10:05:00.000Z",
        provider_ids: ["J2"],
        job: { provider: "fal", id: "J2", attempt: 1 },
        cost: receipt({ operation_id: op }),
      }),
    ]);
    expect(row).toMatchObject({ operations: 1, completed: 1, failed: 0 });
  });

  it("does not let an upload under the same operation id complete a failed job", () => {
    const op = "agent-op-2";
    const row = rowFor([
      entry({ provider_ids: ["file_9"], cost: receipt({ operation_id: op }) }),
      entry({
        ts: "2026-10-27T10:01:00.000Z",
        provider_ids: ["J1"],
        job: { provider: "fal", id: "J1", attempt: 1 },
        cost: receipt({ operation_id: op }),
      }),
      entry({
        ts: "2026-10-27T10:02:00.000Z",
        provider_ids: ["J1"],
        ok: false,
        exit_code: 5,
        error: { code: "JOB_FAILED", message: "the provider failed the job" },
        cost: receipt({ operation_id: op, role: "observation", status: "unknown" }),
      }),
    ]);
    expect(row).toMatchObject({ operations: 1, completed: 0, failed: 1 });
  });

  it("does not fail a job when a poll got a gateway page that says blocked", () => {
    const job = { provider: "fal", id: "j-w", attempt: 1 };
    const row = rowFor([
      entry({ job }),
      entry({
        job,
        ts: "2026-10-27T10:01:00.000Z",
        ok: false,
        exit_code: 5,
        error: { code: "CONTENT_BLOCKED", message: "HTTP 403: you have been blocked" },
      }),
    ]);
    expect(row).toMatchObject({ operations: 1, completed: 1, failed: 0 });
  });

  it("counts an operation with a successful run as completed even when another run was canceled", () => {
    const job = { provider: "fal", id: "j-c", attempt: 1 };
    const row = rowFor([
      entry({ job }),
      entry({
        job,
        ts: "2026-10-27T10:05:00.000Z",
        ok: false,
        exit_code: 1,
        error: { code: "CANCELLED", message: "stopped" },
      }),
    ]);
    expect(row).toMatchObject({ operations: 1, completed: 1, failed: 0, canceled: 0 });
  });

  it("lets the later ledger line decide between runs with the same timestamp", () => {
    const job = (id: string) => ({ provider: "fal", id, attempt: 1 });
    const failed = { ok: false, exit_code: 1 } as const;
    const down = { code: "PROVIDER_UNAVAILABLE", message: "down" };
    const cancel = { code: "CANCELLED", message: "stopped" };
    const row = rowFor([
      entry({ ...failed, job: job("t1"), error: down }),
      entry({ ...failed, job: job("t1"), error: cancel }),
      entry({ ...failed, job: job("t2"), error: cancel }),
      entry({ ...failed, job: job("t2"), error: down }),
    ]);
    expect(row).toMatchObject({ operations: 2, failed: 1, canceled: 1 });
  });

  it("reports no success rate without requests", () => {
    expect(aggregateUsage([], "offering")).toEqual([]);
  });
});

describe("spend is known, unknown or uncertain, never $0", () => {
  it("separates provider-reported spend from computed spend and divides by successes", () => {
    const rows = [
      entry({
        cost: receipt({
          operation_id: "op-a",
          status: "settled",
          actual_usd: 0.5,
          actual_source: "provider_reported",
          provider_reported: { cost_usd: 0.5, credits: null },
        }),
      }),
      entry({
        cost: receipt({
          operation_id: "op-b",
          status: "computed",
          actual_usd: 0.2,
          actual_source: "computed_from_usage",
        }),
      }),
    ];
    const row = rowFor(rows);
    expect(row.cost).toMatchObject({
      known_usd: 0.7,
      provider_reported_usd: 0.5,
      computed_usd: 0.2,
      unknown_operations: 0,
      uncertain_operations: 0,
      per_success_usd: 0.35,
    });
  });

  it("counts a successful run with unknown cost as unknown, not as $0, and leaves per-success null", () => {
    const row = rowFor([
      entry({ cost: receipt({ operation_id: "op-u", status: "unknown", actual_usd: null }) }),
    ]);
    expect(row.cost.known_usd).toBe(0);
    expect(row.cost.unknown_operations).toBe(1);
    expect(row.cost.per_success_usd).toBeNull();
  });

  it("counts a failed run whose billable send left the cost uncertain, and leaves per-success null", () => {
    const row = rowFor([
      entry({
        ok: false,
        exit_code: 1,
        error: { code: "NETWORK_ERROR", message: "cut" },
        cost: receipt({ operation_id: "op-x", status: "uncertain", actual_usd: null }),
      }),
    ]);
    expect(row.cost.uncertain_operations).toBe(1);
    expect(row.cost.per_success_usd).toBeNull();
  });

  it("keeps the pre-flight estimate of an unknown operation out of spend", () => {
    const row = rowFor([
      entry({
        cost: receipt({
          operation_id: "op-e",
          status: "unknown",
          actual_usd: null,
          estimate: {
            status: "estimated",
            expected_usd: 0.3,
            low_usd: 0.1,
            high_usd: 0.5,
            upper_bound: false,
          },
        }),
      }),
    ]);
    expect(row.cost.known_usd).toBe(0);
    expect(row.cost.estimated_usd).toBe(0.3);
  });

  it("prices a run that only has a provider-reported usage cost, as one operation of its own", () => {
    const row = rowFor([
      entry({ id: "h_legacy", usage: { cost_usd: 0.25 } as HistoryEntry["usage"] }),
    ]);
    expect(row.cost).toMatchObject({
      known_usd: 0.25,
      provider_reported_usd: 0.25,
      per_success_usd: 0.25,
    });
  });

  it("sums credits the provider reported", () => {
    const row = rowFor([
      entry({ usage: { credits: 3 } as HistoryEntry["usage"] }),
      entry({ usage: { credits: 2 } as HistoryEntry["usage"] }),
    ]);
    expect(row.credits).toBe(5);
  });

  it("counts a successful run with no cost receipt as unknown cost, not as free", () => {
    const row = rowFor([entry({ id: "h_no_cost" })]);
    expect(row.cost.per_success_usd).toBeNull();
    expect(row.cost.unknown_operations).toBe(1);
  });
});

describe("grouping by model", () => {
  it("groups a run by the model the provider resolved", () => {
    expect(rowFor([entry({ model_resolved: "bytedance/seedance-2.5/text-to-video" })]).key).toBe(
      OFFERING,
    );
  });

  it("groups a run whose provider reported no resolved model under (unknown model)", () => {
    expect(rowFor([entry({ model_resolved: null })], "fal:(unknown model)").requests).toBe(1);
  });

  it("groups a run that has no model fields under (unknown model)", () => {
    const e = entry({ model_resolved: undefined, model: undefined });
    expect(rowFor([e], "fal:(unknown model)").requests).toBe(1);
  });

  it("does not take a legacy requested model as the model the provider ran", () => {
    // Entries from before model_resolved existed carry only the requested `model`.
    const e = entry({ model_resolved: undefined, model: "requested-alias" });
    const rows = aggregateUsage([e], "offering");
    expect(rows.map((r) => r.key)).toEqual(["fal:(unknown model)"]);
  });

  it("groups by task using the command's capability", () => {
    const rows = aggregateUsage(
      [
        entry({ command: "fal video" }),
        entry({ command: "gemini generate-speech", provider: "gemini" }),
      ],
      "task",
    );
    expect(rows.map((r) => r.key).sort()).toEqual(["speech", "video"]);
  });
});

describe("latency", () => {
  it("reports p50 and p95 in seconds with nearest-rank percentiles", () => {
    const durations = [1000, 2000, 3000, 4000, 10000];
    const row = rowFor(durations.map((d) => entry({ duration_ms: d })));
    expect(row.p50_s).toBe(3);
    expect(row.p95_s).toBe(10);
  });

  it("reports no latency without runs", () => {
    expect(aggregateUsage([], "provider")).toEqual([]);
  });
});

describe("confidence", () => {
  it("grades the sample: none at 0, low below 5, medium below 30, high from 30", () => {
    expect([0, 1, 4, 5, 29, 30, 500].map(confidence)).toEqual([
      "none",
      "low",
      "low",
      "medium",
      "medium",
      "high",
      "high",
    ]);
  });

  it("states the sample size and grade on each row", () => {
    const row = rowFor([entry({}), entry({})]);
    expect(row.sample).toEqual({ n: 2, confidence: "low" });
  });
});
