import { describe, expect, it } from "vitest";
import { UsageService } from "../src/usage/usage-service.js";
import type {
  BeginInput,
  CliImportEntry,
  SettleInput,
  UsageFilter,
} from "../src/usage/usage-types.js";
import { memorySql, memoryUsageNamespace, testClock } from "./usage-sql.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup() {
  const clock = testClock();
  const sql = memorySql();
  const usage = new UsageService(sql, clock.now);
  return { clock, sql, usage };
}

let seq = 0;
function jobId(): string {
  seq++;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

function begin(usage: UsageService, at: number, over: Partial<BeginInput> = {}) {
  const input: BeginInput = {
    jobId: jobId(),
    source: "mcp",
    clientId: "mcp:client-a",
    command: "gemini image",
    provider: "gemini",
    modelRequested: "gemini-3-pro-image",
    startedAt: at,
    ...over,
  };
  return { input, result: usage.begin(input) };
}

function settled(id: string, at: number, over: Partial<SettleInput> = {}): SettleInput {
  return {
    jobId: id,
    status: "succeeded",
    createdAt: at - 60_000,
    runningAt: at - 50_000,
    finishedAt: at,
    exitCode: 0,
    outputs: [{ name: "image-1.png", bytes: 1000, stored: true }],
    timings: { inputsMs: 1000, cliMs: 40_000, uploadMs: 2000 },
    run: {
      command: "gemini image",
      provider: "gemini",
      model: "gemini-3-pro-image",
      ok: true,
      exitCode: 0,
      durationMs: 40_000,
      usage: { cost_usd: 0.04, tokens: { input: 100, output: 1290 } },
      http: { requests: 1, errors: 0, ms: 39_000 },
      providerIds: ["resp_123"],
      outputs: [{ name: "image-1.png", bytes: 1000, mime: "image/png", sha256: "a".repeat(64) }],
    },
    ...over,
  };
}

function month(clock: { now: () => number }): UsageFilter {
  return { from: clock.now() - 30 * DAY, to: clock.now() + DAY };
}

describe("usage ledger: remote jobs", () => {
  it("records a job from begin to settle with the provider-reported cost", () => {
    const { clock, usage } = setup();
    const { input, result } = begin(usage, clock.now());
    expect(result).toEqual({ ok: true, reservedUsd: null });
    const event = usage.settle(settled(input.jobId, clock.now() + 60_000));
    expect(event).toMatchObject({
      status: "succeeded",
      actualCostUsd: 0.04,
      provenance: "provider_reported",
      chargeState: "charged",
      modelResolved: "gemini-3-pro-image",
      outputCount: 1,
      tokensOutput: 1290,
      providerIds: ["resp_123"],
    });
    expect(event?.spans.map((s) => s.name)).toEqual(["queue", "inputs", "cli", "upload"]);
    expect(event?.outputs[0]).toMatchObject({
      name: "image-1.png",
      mime: "image/png",
      stored: true,
    });
  });

  it("ignores a replayed settle and a replayed begin", () => {
    const { clock, usage } = setup();
    const { input } = begin(usage, clock.now());
    usage.settle(settled(input.jobId, clock.now() + 1000));
    const again = usage.settle(
      settled(input.jobId, clock.now() + 9000, { status: "failed", run: undefined }),
    );
    expect(again?.status).toBe("succeeded");
    expect(usage.begin(input).ok).toBe(true);
    expect(usage.summary(month(clock)).kpis.jobs).toBe(1);
  });

  it("keeps an unknown cost as null and counts it, never as $0", () => {
    const { clock, usage } = setup();
    const { input } = begin(usage, clock.now());
    const s = settled(input.jobId, clock.now() + 1000);
    if (s.run) s.run.usage = undefined;
    const event = usage.settle(s);
    expect(event?.actualCostUsd).toBeNull();
    expect(event?.estimatedCostUsd).toBeNull();
    expect(event?.provenance).toBe("unknown");
    const kpis = usage.summary(month(clock)).kpis;
    expect(kpis.unknownCostRuns).toBe(1);
    expect(kpis.knownUsd).toBe(0);
    expect(kpis.costPerSucceededRunUsd).toBeNull();
  });

  it("estimates from the account rate card and labels the estimate", () => {
    const { clock, usage } = setup();
    const card = usage.replaceRateCard(
      [
        {
          provider: "gemini",
          model: "*",
          unit: "output",
          usd: 0.03,
          effective_from: "2026-01-01",
          version: "pricing 2026-01",
        },
        {
          provider: "gemini",
          model: "gemini-3-pro-image",
          unit: "output",
          usd: 0.05,
          effective_from: "2026-06-01",
        },
      ],
      "dashboard:gh-1",
    );
    expect(card.ok).toBe(true);
    const { input } = begin(usage, clock.now());
    const s = settled(input.jobId, clock.now() + 1000);
    if (s.run) s.run.usage = undefined;
    const event = usage.settle(s);
    expect(event).toMatchObject({
      estimatedCostUsd: 0.05,
      provenance: "estimated",
      rateSource: "account_rate_card",
      rateEffective: "2026-06-01",
    });
    expect(usage.summary(month(clock)).kpis).toMatchObject({
      estimatedUsd: 0.05,
      actualUsd: 0,
      unknownCostRuns: 0,
    });
  });

  it("marks failures by whether the provider could have charged", () => {
    const { clock, usage } = setup();
    const notStarted = begin(usage, clock.now()).input;
    const noCalls = begin(usage, clock.now()).input;
    const failedMidway = begin(usage, clock.now()).input;
    const oldContainer = begin(usage, clock.now()).input;
    const at = clock.now() + 5000;
    const start = usage.settle({
      jobId: notStarted.jobId,
      status: "failed",
      createdAt: at,
      finishedAt: at,
      exitCode: null,
      error: "The job container could not be started",
      outputs: [],
    });
    const none = usage.settle(
      settled(noCalls.jobId, at, {
        status: "failed",
        exitCode: 3,
        run: {
          command: "gemini image",
          provider: "gemini",
          ok: false,
          exitCode: 3,
          durationMs: 5,
          errorCode: "MISSING_KEY",
          http: { requests: 0, errors: 0, ms: 0 },
        },
      }),
    );
    const midway = usage.settle(
      settled(failedMidway.jobId, at, {
        status: "timed_out",
        exitCode: null,
        run: undefined,
        timings: { inputsMs: 10, cliMs: 50_000, uploadMs: 0 },
      }),
    );
    const old = usage.settle(
      settled(oldContainer.jobId, at, {
        status: "failed",
        exitCode: 1,
        run: undefined,
        timings: undefined,
      }),
    );
    expect(start?.chargeState).toBe("no_charge");
    expect(none).toMatchObject({ chargeState: "no_charge", errorCode: "MISSING_KEY" });
    expect(midway).toMatchObject({ chargeState: "uncertain", errorCode: "TIMEOUT" });
    expect(old?.chargeState).toBe("uncertain");
    const kpis = usage.summary(month(clock)).kpis;
    expect(kpis.uncertainRuns).toBe(2);
    expect(kpis.unknownCostRuns).toBe(2);
  });

  it("releases a job that never started", () => {
    const { clock, usage } = setup();
    const { input } = begin(usage, clock.now());
    usage.release(input.jobId, "SERVER_BUSY", "The server is at capacity");
    expect(usage.event(input.jobId)?.event).toMatchObject({
      status: "rejected",
      chargeState: "no_charge",
      errorCode: "SERVER_BUSY",
    });
  });

  it("stores no URLs or bearer tokens from error text", () => {
    const { clock, usage } = setup();
    const { input } = begin(usage, clock.now());
    const event = usage.settle(
      settled(input.jobId, clock.now(), {
        status: "failed",
        run: undefined,
        error:
          "Upload to https://bucket.example.com/out.png?X-Amz-Signature=abc failed; Bearer sk-secret-token",
      }),
    );
    expect(event?.errorReason).not.toContain("X-Amz-Signature");
    expect(event?.errorReason).not.toContain("sk-secret-token");
  });
});

describe("usage ledger: budgets", () => {
  it("blocks a job that would exceed a blocking budget and records why", () => {
    const { clock, usage } = setup();
    usage.replaceRateCard(
      [{ provider: "gemini", unit: "job", usd: 0.4, effective_from: "2026-01-01" }],
      "t",
    );
    const created = usage.createBudget(
      { name: "Daily cap", scope: "account", period: "day", limitUsd: 1, mode: "block" },
      "dashboard:gh-1",
    );
    expect(created.ok).toBe(true);
    const a = begin(usage, clock.now());
    const b = begin(usage, clock.now());
    const c = begin(usage, clock.now());
    expect(a.result).toEqual({ ok: true, reservedUsd: 0.4 });
    expect(b.result).toEqual({ ok: true, reservedUsd: 0.4 });
    expect(c.result.ok).toBe(false);
    expect(usage.event(c.input.jobId)?.event).toMatchObject({
      status: "rejected",
      errorCode: "BUDGET_EXCEEDED",
      chargeState: "no_charge",
    });
    const status = usage.budgets()[0];
    expect(status).toMatchObject({ heldUsd: 0.8, committedUsd: 0.8 });
    expect(usage.activities({ kind: "budget." }).items.map((x) => x.kind)).toContain(
      "budget.blocked",
    );
    // A finished job swaps its hold for the cost; a no-charge failure frees it.
    usage.settle(settled(a.input.jobId, clock.now() + 1000));
    usage.settle({
      jobId: b.input.jobId,
      status: "failed",
      createdAt: 0,
      finishedAt: clock.now(),
      exitCode: null,
      error: "The job container could not be started",
      outputs: [],
    });
    expect(usage.budgets()[0]).toMatchObject({ actualUsd: 0.04, heldUsd: 0, committedUsd: 0.04 });
    expect(begin(usage, clock.now()).result.ok).toBe(true);
  });

  it("blocks jobs without a price only when the budget says so", () => {
    const { clock, usage } = setup();
    usage.createBudget(
      {
        name: "Strict",
        scope: "provider",
        scopeValue: "gemini",
        period: "month",
        limitUsd: 5,
        mode: "block",
        unknownPrice: "block",
      },
      "t",
    );
    expect(begin(usage, clock.now()).result).toMatchObject({ ok: false, reason: "unknown_price" });
    expect(
      begin(usage, clock.now(), { provider: "openai", command: "openai image" }).result.ok,
    ).toBe(true);
    usage.updateBudget(usage.budgets()[0]?.budget.id ?? "", { reserveUsd: 1 }, "t");
    expect(begin(usage, clock.now()).result).toEqual({ ok: true, reservedUsd: 1 });
  });

  it("fires each alert threshold once per window", () => {
    const { clock, usage } = setup();
    usage.createBudget(
      { name: "Watch", scope: "account", period: "day", limitUsd: 0.1, mode: "alert" },
      "t",
    );
    for (let i = 0; i < 3; i++) {
      const { input } = begin(usage, clock.now());
      usage.settle(settled(input.jobId, clock.now() + 1000));
    }
    const alerts = usage.activities({ kind: "budget.alert" }).items;
    expect(alerts.map((a) => a.meta.threshold).sort()).toEqual([100, 50, 80]);
    expect(usage.budgets()[0]?.crossed).toEqual([50, 80, 100]);
    expect(usage.budgets()[0]?.percent).toBeCloseTo(120);
    // A new day is a new window.
    clock.advance(DAY);
    expect(usage.budgets()[0]).toMatchObject({ committedUsd: 0, crossed: [] });
  });

  it("validates budget input", () => {
    const { usage } = setup();
    expect(
      usage.createBudget({ name: "x", scope: "project", period: "day", limitUsd: 1 }, "t"),
    ).toMatchObject({ ok: false });
    expect(
      usage.createBudget({ name: "x", scope: "account", period: "custom", limitUsd: 1 }, "t"),
    ).toMatchObject({ ok: false });
    expect(
      usage.createBudget({ name: "x", scope: "account", period: "day", limitUsd: -1 }, "t"),
    ).toMatchObject({ ok: false });
  });

  it("lets only one of two concurrent jobs take the last dollars", async () => {
    const clock = testClock();
    const { namespace } = memoryUsageNamespace(clock.now);
    const stub = namespace.getByName("gh-1");
    await stub.replaceRateCard(
      [{ provider: "gemini", unit: "job", usd: 0.6, effective_from: "2026-01-01" }],
      "t",
    );
    await stub.createBudget(
      { name: "cap", scope: "account", period: "day", limitUsd: 1, mode: "block" },
      "t",
    );
    const make = (): BeginInput => ({
      jobId: jobId(),
      source: "rest",
      command: "gemini image",
      provider: "gemini",
      startedAt: clock.now(),
    });
    const results = await Promise.all([stub.begin(make()), stub.begin(make())]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

describe("usage ledger: adjustments, imports, queries", () => {
  it("applies refunds, corrections and billed amounts", () => {
    const { clock, usage } = setup();
    const { input } = begin(usage, clock.now());
    usage.settle(settled(input.jobId, clock.now() + 1000));
    expect(
      usage.adjust(
        input.jobId,
        { kind: "refund", amountUsd: 0.01, reason: "provider credit" },
        "dashboard:gh-1",
      ).ok,
    ).toBe(true);
    expect(usage.summary(month(clock)).kpis.knownUsd).toBe(0.03);
    expect(
      usage.adjust(input.jobId, { kind: "refund", amountUsd: -1, reason: "x" }, "t"),
    ).toMatchObject({ ok: false });

    const other = begin(usage, clock.now()).input;
    usage.settle(settled(other.jobId, clock.now(), { status: "failed", run: undefined }));
    expect(usage.event(other.jobId)?.event.chargeState).toBe("uncertain");
    usage.adjust(
      other.jobId,
      { kind: "billed", amountUsd: 0, reason: "invoice shows no charge" },
      "t",
    );
    expect(usage.event(other.jobId)?.event).toMatchObject({
      chargeState: "no_charge",
      provenance: "billed",
      actualCostUsd: 0,
    });
    expect(usage.summary(month(clock)).kpis.uncertainRuns).toBe(0);
  });

  it("imports CLI history once, keeps only allowlisted fields, and reports rejects", () => {
    const { clock, usage } = setup();
    const entry: CliImportEntry = {
      id: "h_abc123",
      ts: new Date(clock.now() - HOUR).toISOString(),
      duration_ms: 1200,
      command: "elevenlabs tts",
      provider: "elevenlabs",
      model: "eleven_v3",
      ok: true,
      exit_code: 0,
      outputs: [{ ext: "mp3", bytes: 2048, mime: "audio/mpeg", duration_s: 4.5 }],
      usage: { credits: 120, metrics: { "body.character_count": 120 } },
      http: { requests: 1, errors: 0, ms: 900 },
    };
    const withExtras = { ...entry, argv: ["--text", "secret prompt"], cwd: "/home/me" };
    const first = usage.importCli([withExtras, { id: "bad" }], "site", "api_key:k1");
    expect(first).toEqual({
      ok: true,
      value: { accepted: 1, duplicates: 0, rejected: [{ id: "bad", reason: "invalid id" }] },
    });
    expect(usage.importCli([entry], undefined, "api_key:k1")).toMatchObject({
      ok: true,
      value: { accepted: 0, duplicates: 1 },
    });
    const event = usage.event("cli_h_abc123")?.event;
    expect(event).toMatchObject({
      source: "cli",
      project: "site",
      credits: 120,
      characters: 120,
      audioSeconds: 4.5,
      chargeState: "charged",
    });
    expect(JSON.stringify(event)).not.toContain("secret prompt");
    expect(JSON.stringify(event)).not.toContain("/home/me");
    expect(usage.importCli(new Array(501).fill(entry), undefined, "t")).toMatchObject({
      ok: false,
    });
  });

  it("summarises by provider, model, source and client consistently", () => {
    const { clock, usage } = setup();
    const runs: Array<[string, string, "mcp" | "rest", string, number]> = [
      ["gemini", "gemini-3-pro-image", "mcp", "mcp:a", 0.04],
      ["gemini", "gemini-3-pro-image", "rest", "api_key:k1", 0.04],
      ["openai", "gpt-image-2", "mcp", "mcp:a", 0.08],
      ["elevenlabs", "eleven_v3", "rest", "api_key:k1", 0.02],
    ];
    for (const [provider, model, source, clientId, cost] of runs) {
      const { input } = begin(usage, clock.now() - 2 * HOUR, {
        provider,
        command: `${provider} x`,
        source,
        clientId,
        modelRequested: model,
      });
      const s = settled(input.jobId, clock.now() - HOUR);
      if (s.run) {
        s.run.provider = provider;
        s.run.model = model;
        s.run.usage = { cost_usd: cost };
      }
      usage.settle(s);
    }
    const summary = usage.summary(month(clock));
    expect(summary.kpis).toMatchObject({ jobs: 4, succeeded: 4, knownUsd: 0.18, successRate: 100 });
    expect(summary.breakdown.provider.map((r) => [r.key, r.knownUsd])).toEqual([
      ["gemini", 0.08],
      ["openai", 0.08],
      ["elevenlabs", 0.02],
    ]);
    expect(summary.breakdown.client.find((r) => r.key === "mcp:a")?.knownUsd).toBe(0.12);
    expect(summary.series.reduce((s, b) => s + b.knownUsd, 0)).toBeCloseTo(0.18);
    expect(summary.bucket).toBe("day");
    const digest = usage.digest(month(clock));
    expect(digest.kpis.knownUsd).toBe(summary.kpis.knownUsd);

    const page1 = usage.events(month(clock), null, 3);
    expect(page1.ok && page1.value.items).toHaveLength(3);
    const next = page1.ok ? page1.value.next : null;
    const page2 = usage.events(month(clock), next, 3);
    expect(page2.ok && page2.value.items).toHaveLength(1);
    expect(
      usage.events({ ...month(clock), provider: "openai" }, null).ok &&
        usage.events({ ...month(clock), provider: "openai" }, null),
    ).toMatchObject({ value: { items: [{ provider: "openai" }] } });
  });

  it("keeps accounts apart", async () => {
    const clock = testClock();
    const { namespace } = memoryUsageNamespace(clock.now);
    const a = namespace.getByName("gh-1");
    const b = namespace.getByName("gh-2");
    const id = jobId();
    await a.begin({
      jobId: id,
      source: "mcp",
      command: "gemini image",
      provider: "gemini",
      startedAt: clock.now(),
    });
    expect((await b.summary(month(clock))).kpis.jobs).toBe(0);
    expect(await b.event(id)).toBeNull();
    expect((await a.summary(month(clock))).kpis.jobs).toBe(1);
  });
});

describe("usage ledger: activities, retention, deletion", () => {
  it("chains activity hashes and detects an edited row", () => {
    const { sql, usage } = setup();
    usage.recordActivity({ actor: "dashboard:gh-1", kind: "auth.sign_in" });
    usage.recordActivity({
      actor: "dashboard:gh-1",
      kind: "provider_key.saved",
      target: "GEMINI_API_KEY",
    });
    usage.recordActivity({
      actor: "dashboard:gh-1",
      kind: "api_key.created",
      target: "k1",
      meta: { name: "ci" },
    });
    expect(usage.verifyActivities()).toEqual({ ok: true, checked: 3, brokenAtSeq: null });
    sql.exec("UPDATE activities SET target = 'OPENAI_API_KEY' WHERE seq = 2");
    expect(usage.verifyActivities()).toMatchObject({ ok: false, brokenAtSeq: 2 });
  });

  it("drops what is older than the retention window and expires debug logs", () => {
    const { clock, usage } = setup();
    const old = begin(usage, clock.now() - 401 * DAY).input;
    const recent = begin(usage, clock.now() - DAY).input;
    usage.setDebugCapture(true, "t");
    usage.settle(
      settled(recent.jobId, clock.now(), {
        status: "failed",
        stderrTail: "error at https://x.example/a?sig=1",
      }),
    );
    expect(usage.event(recent.jobId)?.hasDebugLog).toBe(true);
    expect(usage.readDebugLog(recent.jobId, "dashboard:gh-1")).not.toContain("sig=1");
    usage.prune();
    expect(usage.event(old.jobId)).toBeNull();
    expect(usage.event(recent.jobId)).not.toBeNull();
    clock.advance(8 * DAY);
    usage.prune();
    expect(usage.event(recent.jobId)?.hasDebugLog).toBe(false);
  });

  it("does not keep debug logs while capture is off", () => {
    const { clock, usage } = setup();
    const { input } = begin(usage, clock.now());
    usage.settle(settled(input.jobId, clock.now(), { status: "failed", stderrTail: "boom" }));
    expect(usage.event(input.jobId)?.hasDebugLog).toBe(false);
  });

  it("deletes every usage record and logs the deletion", () => {
    const { clock, usage } = setup();
    const { input } = begin(usage, clock.now());
    usage.settle(settled(input.jobId, clock.now()));
    expect(usage.deleteUsage("dashboard:gh-1")).toBe(1);
    expect(usage.summary(month(clock)).kpis.jobs).toBe(0);
    expect(usage.activities({ kind: "usage.deleted" }).items).toHaveLength(1);
  });

  it("stays fast with 50k events", () => {
    const { clock, sql, usage } = setup();
    sql.transaction(() => {
      for (let i = 0; i < 50_000; i++) {
        const at = clock.now() - (i % 90) * DAY - i;
        sql.exec(
          `INSERT INTO usage_events (id, schema_version, source, trace_id, command, provider, model_resolved, status, started_at, finished_at, duration_ms, actual_cost_usd, provenance, charge_state, output_count, settled, created_at, updated_at)
           VALUES (?, 1, 'mcp', ?, 'gemini image', ?, 'm', 'succeeded', ?, ?, ?, 0.01, 'provider_reported', 'charged', 1, 1, ?, ?)`,
          `e${i}`,
          `e${i}`,
          i % 3 ? "gemini" : "openai",
          at,
          at + 1000,
          1000 + (i % 500),
          at,
          at,
        );
      }
    });
    const started = performance.now();
    const summary = usage.summary({ from: clock.now() - 90 * DAY, to: clock.now() + 1 });
    usage.events({ from: clock.now() - 90 * DAY, to: clock.now() + 1 }, null, 50);
    const ms = performance.now() - started;
    expect(summary.kpis.jobs).toBe(50_000);
    expect(ms).toBeLessThan(5000);
  });
});
