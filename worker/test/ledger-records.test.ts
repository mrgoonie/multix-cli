/**
 * Ledger records built from jobs and CLI history imports: only measurements
 * are kept, unknown numbers stay null, and the job runner records who started
 * a job without failing the job when the ledger is down.
 */

import { describe, expect, it } from "vitest";
import { relayOutbox } from "../src/events/event-outbox.js";
import type { JobQuota } from "../src/jobs/account-job-quota.js";
import { DEFAULT_JOB_CAPS } from "../src/jobs/account-job-quota.js";
import type { JobSpec, JobView } from "../src/jobs/job-protocol.js";
import { JobRunner } from "../src/jobs/job-runner.js";
import { type JobBackend, JobStore } from "../src/jobs/job-store.js";
import type { AccountLedgerStub } from "../src/ledger/account-ledger.js";
import {
  type JobLedgerMeta,
  importRecords,
  jobFinishRecord,
  jobStartRecord,
  modelFromArgv,
} from "../src/ledger/ledger-records.js";
import type { OperationInput } from "../src/ledger/ledger-types.js";
import { fakeKv } from "./fake-kv.js";

const JOB = "7d3f0a52-2b1c-4c1e-9a55-0d6c1f2e3a4b";
const META: JobLedgerMeta = {
  source: "rest",
  clientId: "api_key:k1",
  clientName: null,
  command: "gemini generate",
  model: "gemini-2.5-flash",
  startedAt: 1_000,
};

const finished = (overrides: Partial<JobView> = {}): JobView => ({
  status: "succeeded",
  createdAt: 1_000,
  finishedAt: 9_000,
  result: {
    status: "succeeded",
    exitCode: 0,
    stdout: "saved out/cat.png",
    stderrTail: "",
    outputs: [
      { name: "cat.png", url: "https://media.example.com/cat.png?X-Amz-Signature=abc", bytes: 42 },
    ],
  },
  ...overrides,
});

describe("modelFromArgv", () => {
  it("reads --model in both forms and stops at positionals", () => {
    expect(modelFromArgv(["gemini", "generate", "--model=imagen-4"])).toBe("imagen-4");
    expect(modelFromArgv(["fal", "run", "--model", "fal-ai/flux/dev"])).toBe("fal-ai/flux/dev");
    expect(modelFromArgv(["gemini", "generate", "--", "--model=x"])).toBeNull();
    expect(modelFromArgv(["x", "--model=https://evil.example/m"])).toBeNull();
    expect(modelFromArgv(["gemini", "generate"])).toBeNull();
  });
});

describe("job records", () => {
  it("starts as running with unknown measurements", () => {
    expect(jobStartRecord(JOB, META)).toMatchObject({
      op_id: `job_${JOB}`,
      trace_id: JOB,
      provider: "gemini",
      status: "running",
      actual_cost_usd: null,
      cost_provenance: "unknown",
      tokens_input: null,
    });
  });

  it("keeps costs unknown when the container reported no usage", () => {
    const record = jobFinishRecord(JOB, META, finished(), 10_000);
    expect(record).toMatchObject({
      status: "succeeded",
      started_at: 1_000,
      finished_at: 9_000,
      duration_ms: 8_000,
      output_count: 1,
      output_bytes: 42,
      actual_cost_usd: null,
      estimated_cost_usd: null,
      cost_provenance: "unknown",
      credits: null,
      tokens_total: null,
      error_code: null,
    });
    expect(JSON.stringify(record)).not.toContain("X-Amz-Signature");
    expect(JSON.stringify(record)).not.toContain("saved out");
  });

  it("maps the container usage report and phase timings", () => {
    const view = finished();
    if (!view.result) throw new Error("no result");
    view.result.usage = {
      model: "imagen-4.0",
      tokens: { input: 12, output: 30 },
      costUsd: 0.04,
      credits: 3,
      http: { requests: 2, errors: 1, ms: 900 },
      providerIds: ["req_1", "https://x.example/leak", "/etc/passwd"],
      metrics: { "usage.images": 1, "bad key!": 2 },
      outputs: [{ name: "cat.png", bytes: 42, mime: "image/PNG", sha256: "A".repeat(64) }],
    };
    view.result.timings = {
      startedAt: 1_100,
      inputsDoneAt: 1_200,
      cliDoneAt: 8_000,
      uploadsDoneAt: 8_500,
    };
    const record = jobFinishRecord(JOB, META, view, 10_000);
    expect(record).toMatchObject({
      model: "imagen-4.0",
      tokens_input: 12,
      tokens_output: 30,
      tokens_total: null,
      actual_cost_usd: 0.04,
      cost_provenance: "provider_reported",
      credits: 3,
      credits_unit: "provider_credits",
      http_requests: 2,
      http_errors: 1,
    });
    expect(record.detail).toEqual({
      provider_ids: ["req_1"],
      metrics: { "usage.images": 1 },
      outputs: [{ bytes: 42, mime: "image/png", sha256: "a".repeat(64) }],
      spans: [
        { name: "inputs", start: 1_100, end: 1_200 },
        { name: "cli", start: 1_200, end: 8_000 },
        { name: "uploads", start: 8_000, end: 8_500 },
        { name: "finish", start: 8_500, end: 9_000 },
      ],
    });
  });

  it("classifies failures by the CLI's code, else by the job status", () => {
    const failed = finished({ status: "failed" });
    if (failed.result) failed.result.usage = { errorCode: "RATE_LIMITED" };
    expect(jobFinishRecord(JOB, META, failed, 10_000).error_code).toBe("RATE_LIMITED");
    expect(
      jobFinishRecord(JOB, META, finished({ status: "timed_out", result: undefined }), 10_000),
    ).toMatchObject({
      status: "timed_out",
      error_code: "TIMEOUT",
      output_count: 0,
    });
  });
});

describe("importRecords", () => {
  const entry = {
    id: "h_lx2k3abcd",
    ts: "2026-10-20T10:00:00.000Z",
    duration_ms: 1500,
    command: "gemini generate",
    provider: "gemini",
    model: "gemini-2.5-flash",
    ok: true,
    exit_code: 0,
    usage: { tokens: { input: 5 }, cost_usd: 0.01 },
    outputs: [{ bytes: 10, sha256: "b".repeat(64) }],
    version: "1.2.3",
  };

  it("maps CLI history entries to cli operations", () => {
    const { operations, rejected } = importRecords([entry], "api_key:k1");
    expect(rejected).toBe(0);
    expect(operations[0]).toMatchObject({
      op_id: "cli_h_lx2k3abcd",
      history_id: "h_lx2k3abcd",
      source: "cli",
      client_id: "api_key:k1",
      status: "succeeded",
      started_at: Date.parse(entry.ts),
      finished_at: Date.parse(entry.ts) + 1500,
      tokens_input: 5,
      tokens_output: null,
      actual_cost_usd: 0.01,
      cost_provenance: "provider_reported",
      output_count: 1,
      output_bytes: 10,
      detail: { outputs: [{ bytes: 10, sha256: "b".repeat(64) }], cli_version: "1.2.3" },
    });
  });

  it("rejects malformed entries and never copies extra fields", () => {
    const { operations, rejected } = importRecords(
      [
        { ...entry, id: "../../etc" },
        { ...entry, ts: "yesterday" },
        { ...entry, ok: "yes" },
        { ...entry, command: "gemini generate; rm -rf /" },
        "not an object",
        { ...entry, id: "h_2", ok: false, argv: ["--prompt", "secret prompt"], cwd: "/home/me" },
      ],
      "api_key:k1",
    );
    expect(rejected).toBe(5);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ status: "failed", error_code: "CLI_FAILED" });
    expect(JSON.stringify(operations)).not.toMatch(/secret prompt|\/home\/me/);
  });
});

describe("relayOutbox", () => {
  it("relays any record type and keeps entries when the hand-over fails", async () => {
    const stored = new Map<string, OperationInput>([
      ["ledger-outbox:job_1", jobStartRecord(JOB, META)],
    ]);
    const scheduled: number[] = [];
    const port = {
      label: "ledger",
      list: async () => new Map(stored),
      delete: async (keys: string[]) => {
        for (const key of keys) stored.delete(key);
      },
      publish: async () => {
        throw new Error("down");
      },
      scheduleRelay: async (attempt: number) => {
        scheduled.push(attempt);
      },
    };
    await relayOutbox(port, 1);
    expect(stored.size).toBe(1);
    expect(scheduled).toEqual([2]);
    await relayOutbox({ ...port, publish: async () => undefined }, 2);
    expect(stored.size).toBe(0);
  });
});

describe("JobRunner ledger records", () => {
  const quota: JobQuota = { acquire: async () => "ok", release: async () => undefined };
  const backend = (seen: unknown[]): JobBackend => ({
    start: async (
      _jobId: string,
      _spec: JobSpec,
      _userId: string,
      _command: string,
      meta?: unknown,
    ) => {
      seen.push(meta);
      return finished();
    },
    status: async () => finished(),
    cancel: async () => null,
  });
  const prepared = {
    command: "gemini generate",
    group: "gemini",
    argv: ["gemini", "generate", "--model=imagen-4", "--", "a secret prompt"],
    inputs: [],
  };

  it("records the start with who called and hands the metadata to the job", async () => {
    const seen: unknown[] = [];
    const starts: OperationInput[] = [];
    const ledger = {
      recordStart: async (input: OperationInput) => {
        starts.push(input);
        return "accepted";
      },
    } as unknown as AccountLedgerStub;
    const runner = new JobRunner({
      userId: "u1",
      keys: {},
      store: new JobStore(fakeKv() as unknown as KVNamespace),
      backend: backend(seen),
      quota,
      caps: DEFAULT_JOB_CAPS,
      r2Settings: async () => null,
      ledger,
      origin: { source: "mcp", clientId: "client-1", clientName: null },
      now: () => 5_000,
    });
    const payload = await runner.run(prepared, 0);
    expect(payload.status).toBe("succeeded");
    expect(seen[0]).toEqual({
      source: "mcp",
      clientId: "client-1",
      clientName: null,
      command: "gemini generate",
      model: "imagen-4",
      startedAt: 5_000,
    });
    expect(starts[0]).toMatchObject({
      source: "mcp",
      client_id: "client-1",
      status: "running",
      model: "imagen-4",
    });
    expect(JSON.stringify(starts)).not.toContain("secret prompt");
  });

  it("still runs the job when the ledger is unavailable", async () => {
    const seen: unknown[] = [];
    const ledger = {
      recordStart: async () => {
        throw new Error("ledger down");
      },
    } as unknown as AccountLedgerStub;
    const runner = new JobRunner({
      userId: "u1",
      keys: {},
      store: new JobStore(fakeKv() as unknown as KVNamespace),
      backend: backend(seen),
      quota,
      caps: DEFAULT_JOB_CAPS,
      r2Settings: async () => null,
      ledger,
      now: () => 5_000,
    });
    expect((await runner.run(prepared, 0)).status).toBe("succeeded");
    expect(seen[0]).toMatchObject({ source: "unknown", clientId: null });
  });

  it("sends no ledger metadata without a ledger", async () => {
    const seen: unknown[] = [];
    const runner = new JobRunner({
      userId: "u1",
      keys: {},
      store: new JobStore(fakeKv() as unknown as KVNamespace),
      backend: backend(seen),
      quota,
      caps: DEFAULT_JOB_CAPS,
      r2Settings: async () => null,
      now: () => 5_000,
    });
    await runner.run(prepared, 0);
    expect(seen).toEqual([undefined]);
  });
});
