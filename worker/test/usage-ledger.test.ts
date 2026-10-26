/**
 * The usage ledger on a real SQLite database (node:sqlite): idempotent
 * records, unknown costs kept as null, aggregates, budgets and their alerts,
 * the activity hash chain, retention and deletion.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { OperationInput } from "../src/ledger/ledger-types.js";
import { sha256HexSync } from "../src/ledger/sha256-sync.js";
import {
  MAX_BUDGETS,
  type SqlPort,
  UsageLedger,
  periodBounds,
} from "../src/ledger/usage-ledger.js";
import { openSqlite, sqliteSqlPort } from "./sqlite-sql-port.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0); // Thursday 15 Oct 2026, 12:00 UTC

function op(id: string, overrides: Partial<OperationInput> = {}): OperationInput {
  return {
    op_id: id,
    source: "mcp",
    client_id: "client-a",
    client_name: "Claude",
    project_id: null,
    trace_id: id,
    job_id: id,
    history_id: null,
    command: "gemini generate",
    provider: "gemini",
    model: "gemini-2.5-flash",
    task: null,
    status: "succeeded",
    error_code: null,
    started_at: T0,
    finished_at: T0 + 2000,
    duration_ms: 2000,
    output_count: 1,
    output_bytes: 1000,
    tokens_input: 10,
    tokens_output: 20,
    tokens_total: 30,
    tokens_thinking: null,
    credits: null,
    credits_unit: null,
    estimated_cost_usd: null,
    actual_cost_usd: 0.5,
    cost_provenance: "provider_reported",
    rate_source: null,
    http_requests: 1,
    http_errors: 0,
    detail: {},
    ...overrides,
  };
}

let now: number;
let port: SqlPort;
let ledger: UsageLedger;

beforeEach(async () => {
  now = T0;
  port = sqliteSqlPort(await openSqlite());
  ledger = new UsageLedger(port, () => now);
});

describe("sha256HexSync", () => {
  it("matches known vectors and WebCrypto", async () => {
    expect(sha256HexSync("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256HexSync("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    for (const text of ["a".repeat(55), "b".repeat(56), "c".repeat(64), "ứng dụng ✓".repeat(40)]) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      expect(sha256HexSync(text)).toBe(hex);
    }
  });
});

describe("migrations", () => {
  it("creates the schema once and reopens without re-running it", () => {
    expect(ledger.schemaVersion()).toBe(1);
    ledger.recordFinish(op("job_1"));
    const reopened = new UsageLedger(port, () => now);
    expect(reopened.schemaVersion()).toBe(1);
    expect(reopened.getOperation("job_1")?.status).toBe("succeeded");
  });
});

describe("operations", () => {
  it("records a start once and lets the first final record win", () => {
    expect(ledger.recordStart(op("job_1", { status: "running", actual_cost_usd: null }))).toBe(
      "accepted",
    );
    expect(ledger.recordStart(op("job_1", { status: "running" }))).toBe("duplicate");
    expect(ledger.getOperation("job_1")?.status).toBe("running");

    now = T0 + 5000;
    expect(ledger.recordFinish(op("job_1", { source: "unknown", client_id: null }))).toBe(
      "accepted",
    );
    // A replayed or conflicting final record is ignored.
    expect(ledger.recordFinish(op("job_1", { status: "failed", actual_cost_usd: 9 }))).toBe(
      "duplicate",
    );
    const stored = ledger.getOperation("job_1");
    expect(stored).toMatchObject({
      status: "succeeded",
      actual_cost_usd: 0.5,
      source: "mcp",
      client_id: "client-a",
      schema_version: 1,
      currency: "USD",
    });
    const jobEvents = ledger.listActivities({ kind: "job." }).activities;
    expect(jobEvents.map((a) => a.kind)).toEqual(["job.succeeded"]);
  });

  it("keeps unknown values null and counts unknown costs separately", () => {
    ledger.recordFinish(
      op("job_1", {
        actual_cost_usd: null,
        cost_provenance: "unknown",
        tokens_input: null,
        tokens_output: null,
      }),
    );
    expect(ledger.getOperation("job_1")).toMatchObject({
      actual_cost_usd: null,
      estimated_cost_usd: null,
      tokens_input: null,
    });
    const { totals } = ledger.summary({ from: T0 - DAY, to: T0 + DAY });
    expect(totals.unknown_cost_operations).toBe(1);
    expect(totals.known_cost_usd).toBe(0);
    expect(totals.tokens_input).toBeNull();
    expect(totals.credits).toBeNull();
    expect(totals.cost_per_successful_output_usd).toBeNull();
  });

  it("imports CLI runs idempotently", () => {
    const runs = [op("cli_a", { source: "cli" }), op("cli_b", { source: "cli" })];
    expect(ledger.importOperations(runs, "api_key:k1")).toEqual({ accepted: 2, duplicates: 0 });
    expect(ledger.importOperations(runs, "api_key:k1")).toEqual({ accepted: 0, duplicates: 2 });
    expect(ledger.summary({ from: T0 - DAY, to: T0 + DAY }).totals.operations).toBe(2);
    // CLI runs do not add job activities; each import adds one entry.
    const kinds = ledger.listActivities({}).activities.map((a) => a.kind);
    expect(kinds).toEqual(["usage.imported", "usage.imported"]);
  });

  it("pages newest first with a stable cursor and filters", () => {
    for (let i = 0; i < 5; i++) {
      ledger.recordFinish(
        op(`job_${i}`, { started_at: T0 + i * 1000, provider: i % 2 ? "fal" : "gemini" }),
      );
    }
    const first = ledger.listOperations({}, 2);
    expect(first.operations.map((o) => o.op_id)).toEqual(["job_4", "job_3"]);
    const second = ledger.listOperations({}, 2, first.next_cursor ?? undefined);
    expect(second.operations.map((o) => o.op_id)).toEqual(["job_2", "job_1"]);
    const third = ledger.listOperations({}, 2, second.next_cursor ?? undefined);
    expect(third.operations.map((o) => o.op_id)).toEqual(["job_0"]);
    expect(third.next_cursor).toBeNull();
    expect(ledger.listOperations({ provider: "fal" }).operations).toHaveLength(2);
    // A malformed cursor is ignored rather than injected.
    expect(ledger.listOperations({}, 10, "1'; DROP TABLE operations;--").operations).toHaveLength(
      5,
    );
  });
});

describe("summary", () => {
  it("totals costs, adjustments, latency percentiles and groups", () => {
    ledger.recordFinish(op("job_1", { duration_ms: 1000, actual_cost_usd: 1 }));
    ledger.recordFinish(
      op("job_2", {
        provider: "fal",
        duration_ms: 3000,
        actual_cost_usd: null,
        estimated_cost_usd: 0.25,
        cost_provenance: "estimated",
      }),
    );
    ledger.recordFinish(
      op("job_3", {
        status: "failed",
        duration_ms: 5000,
        output_count: 0,
        actual_cost_usd: null,
        cost_provenance: "unknown",
        started_at: T0 + DAY,
      }),
    );
    expect(
      ledger.addAdjustment("job_1", "refund", -0.5, "partial refund", "user:u1"),
    ).not.toBeNull();
    expect(ledger.addAdjustment("missing", "refund", -1, null, "user:u1")).toBeNull();

    const summary = ledger.summary({ from: T0 - DAY, to: T0 + 2 * DAY }, "provider");
    expect(summary.totals).toMatchObject({
      operations: 3,
      succeeded: 2,
      failed: 1,
      success_rate: 0.666667,
      provider_reported_cost_usd: 1,
      estimated_cost_usd: 0.25,
      adjustments_usd: -0.5,
      known_cost_usd: 0.75,
      unknown_cost_operations: 1,
      latency_p50_ms: 3000,
      latency_p95_ms: 5000,
    });
    expect(summary.groups.map((g) => [g.key, g.known_cost_usd])).toEqual([
      ["gemini", 0.5],
      ["fal", 0.25],
    ]);
    expect(summary.series).toEqual([
      {
        bucket_start: Date.UTC(2026, 9, 15),
        operations: 2,
        failed: 0,
        known_cost_usd: 0.75,
        unknown_cost_operations: 0,
      },
      {
        bucket_start: Date.UTC(2026, 9, 16),
        operations: 1,
        failed: 1,
        known_cost_usd: 0,
        unknown_cost_operations: 1,
      },
    ]);
  });
});

describe("budgets", () => {
  const input = {
    name: "Gemini monthly",
    scope_kind: "provider" as const,
    scope_value: "gemini",
    period: "month" as const,
    limit_usd: 2,
    thresholds: [50, 80, 100],
  };

  it("computes UTC period bounds with weeks starting Monday", () => {
    expect(periodBounds("day", T0)).toEqual({
      start: Date.UTC(2026, 9, 15),
      end: Date.UTC(2026, 9, 16),
    });
    expect(periodBounds("week", T0)).toEqual({
      start: Date.UTC(2026, 9, 12),
      end: Date.UTC(2026, 9, 19),
    });
    expect(periodBounds("month", T0)).toEqual({
      start: Date.UTC(2026, 9, 1),
      end: Date.UTC(2026, 10, 1),
    });
  });

  it("raises each threshold once per period, scoped to the budget", () => {
    const budget = ledger.createBudget(input, "user:u1");
    expect(budget).not.toBeNull();
    ledger.recordFinish(op("job_other", { provider: "fal", actual_cost_usd: 50 }));
    expect(ledger.budgetStatuses()[0]).toMatchObject({ spent_usd: 0, state: "ok", alerts: [] });

    ledger.recordFinish(op("job_1", { actual_cost_usd: 1.1 }));
    expect(ledger.budgetStatuses()[0]).toMatchObject({
      spent_usd: 1.1,
      percent: 55,
      state: "warning",
      alerts: [50],
    });
    ledger.recordFinish(op("job_2", { actual_cost_usd: 1 }));
    const status = ledger.budgetStatuses()[0];
    expect(status).toMatchObject({ spent_usd: 2.1, state: "exceeded", alerts: [50, 80, 100] });
    expect(status?.forecast_usd).toBeGreaterThan(2.1);
    ledger.recordFinish(op("job_3", { actual_cost_usd: 1 }));
    const crossed = ledger.listActivities({ kind: "budget.threshold_crossed" }).activities;
    expect(crossed.map((a) => a.metadata.threshold).sort()).toEqual([100, 50, 80]);

    // Next month starts clean.
    now = Date.UTC(2026, 10, 2);
    expect(ledger.budgetStatuses()[0]).toMatchObject({ spent_usd: 0, alerts: [], state: "ok" });
  });

  it("reports operations with unknown cost next to the spend", () => {
    ledger.createBudget({ ...input, scope_kind: "account", scope_value: null }, "user:u1");
    ledger.recordFinish(op("job_1", { actual_cost_usd: null, cost_provenance: "unknown" }));
    expect(ledger.budgetStatuses()[0]).toMatchObject({ spent_usd: 0, unknown_cost_operations: 1 });
  });

  it("updates, deletes and caps the number of budgets", () => {
    const budget = ledger.createBudget(input, "user:u1");
    if (!budget) throw new Error("no budget");
    expect(ledger.updateBudget(budget.id, { ...input, limit_usd: 10 }, "user:u1")?.limit_usd).toBe(
      10,
    );
    expect(ledger.updateBudget("missing", input, "user:u1")).toBeNull();
    expect(ledger.deleteBudget(budget.id, "user:u1")).toBe(true);
    expect(ledger.deleteBudget(budget.id, "user:u1")).toBe(false);
    for (let i = 0; i < MAX_BUDGETS; i++)
      expect(ledger.createBudget(input, "user:u1")).not.toBeNull();
    expect(ledger.createBudget(input, "user:u1")).toBeNull();
  });
});

describe("activities", () => {
  it("chains hashes and detects tampering", () => {
    ledger.appendActivity({
      actor: "user:u1",
      kind: "auth.signed_in",
      subject: null,
      metadata: {},
    });
    ledger.appendActivity({
      actor: "user:u1",
      kind: "provider_key.saved",
      subject: "GEMINI_API_KEY",
      metadata: { nested: { no: 1 } as unknown as string, ok: true, "Bad Key": 1 },
    });
    const listed = ledger.listActivities({}).activities;
    expect(listed[0]?.metadata).toEqual({ ok: true });
    expect(listed[0]?.prev_hash).toBe(listed[1]?.hash);
    expect(ledger.verifyActivities()).toEqual({ ok: true, checked: 2, first_bad_seq: null });

    port.query("UPDATE activities SET subject = 'OPENAI_API_KEY' WHERE seq = 2");
    expect(ledger.verifyActivities()).toEqual({ ok: false, checked: 1, first_bad_seq: 2 });
  });

  it("searches and pages activities", () => {
    for (let i = 0; i < 4; i++) {
      ledger.appendActivity({
        actor: "user:u1",
        kind: i % 2 ? "budget.created" : "api_key.created",
        subject: `s${i}`,
        metadata: {},
      });
    }
    expect(ledger.listActivities({ kind: "budget." }).activities).toHaveLength(2);
    expect(ledger.listActivities({ q: "S3" }).activities.map((a) => a.subject)).toEqual(["s3"]);
    const page = ledger.listActivities({}, 3);
    expect(page.activities).toHaveLength(3);
    const rest = ledger.listActivities({ before: Number(page.next_cursor) }, 3);
    expect(rest.activities.map((a) => a.subject)).toEqual(["s0"]);
  });
});

describe("retention and deletion", () => {
  it("prunes old rows and keeps the remaining chain verifiable", () => {
    ledger.recordFinish(op("job_old", { started_at: T0 }));
    now = T0 + 401 * DAY;
    ledger.recordFinish(op("job_new", { started_at: now }));
    expect(ledger.prune()).toEqual({ operations: 1, activities: 1 });
    expect(ledger.getOperation("job_old")).toBeNull();
    expect(ledger.getOperation("job_new")).not.toBeNull();
    expect(ledger.verifyActivities().ok).toBe(true);
  });

  it("deletes all data but logs the deletion", () => {
    ledger.recordFinish(op("job_1"));
    ledger.createBudget(
      {
        name: "b",
        scope_kind: "account",
        scope_value: null,
        period: "day",
        limit_usd: 1,
        thresholds: [100],
      },
      "user:u1",
    );
    ledger.deleteAllData("user:u1");
    expect(ledger.storageStats()).toEqual({ operations: 0, activities: 1, budgets: 1 });
    expect(ledger.listActivities({}).activities[0]?.kind).toBe("ledger.deleted");
    expect(ledger.verifyActivities().ok).toBe(true);
  });

  it("rolls back a transaction that throws", () => {
    expect(() =>
      port.transaction(() => {
        ledger.recordFinish(op("job_1"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(ledger.getOperation("job_1")).toBeNull();
  });
});
