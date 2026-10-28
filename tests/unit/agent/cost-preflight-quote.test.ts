/**
 * Pre-flight cost for commands priced by a live provider quote (Sume): the
 * quote is free and keyless, so it goes around the fetch telemetry (never a
 * billable call, never stopped by --dry-run); --estimate prints it and sends
 * nothing else; --max-cost refuses a quote above the limit and an
 * unavailable quote.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatEstimate, preflightCost } from "../../../src/agent/cost-preflight.js";
import { installFetchTelemetry } from "../../../src/agent/fetch-telemetry.js";
import { run } from "../../../src/agent/run-state.js";
import { BudgetError } from "../../../src/core/errors.js";
import { SUME_ESTIMATE_URL } from "../../../src/providers/sume/models.js";
import { type FakeResponse, createFakeSume } from "../providers/sume/fake-sume.js";

const original = globalThis.fetch;
const QUOTE = {
  data: {
    model: "kling-4",
    currency: "USD",
    usd: "1.68",
    billing: { unit: "second", quantity: 10, duration_seconds: 10, resolution: "1080p" },
  },
};

let fake: ReturnType<typeof createFakeSume>;
let dryRunStops = 0;

function setup(response: FakeResponse, options: Record<string, unknown>, dryRun = false) {
  fake = createFakeSume({ [`POST ${SUME_ESTIMATE_URL}`]: [response] });
  globalThis.fetch = fake.fetch as typeof fetch;
  installFetchTelemetry(() => {
    dryRunStops++;
    throw new Error("dry run stop");
  });
  run.command = "sume video";
  run.options = { model: "kling-4", duration: "10", ...options };
  run.dryRun = dryRun;
}

beforeEach(() => {
  dryRunStops = 0;
});

afterEach(() => {
  globalThis.fetch = original;
  run.command = "";
  run.options = {};
  run.dryRun = false;
  run.calls = [];
  run.estimate = undefined;
  run.maxCost = undefined;
  run.budget = undefined;
});

describe("preflightCost with a live quote", () => {
  it("--estimate prints the quote and sends no generate request", async () => {
    setup({ json: QUOTE }, { estimate: true, dryRun: true }, true);
    expect(await preflightCost()).toBe(true);
    expect(fake.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${SUME_ESTIMATE_URL}`]);
    expect(dryRunStops).toBe(0);
    expect(run.calls).toEqual([]);
    const printed = formatEstimate(run.estimate as NonNullable<typeof run.estimate>, run.budget);
    expect(printed).toContain("$1.6800 expected");
    expect(printed).toContain("proven ceiling");
    expect(printed).toContain(SUME_ESTIMATE_URL);
    expect(printed).toContain("Nothing was sent");
  });

  it("passes --max-cost at or above the quote", async () => {
    setup({ json: QUOTE }, { maxCost: "2" });
    expect(await preflightCost()).toBe(false);
    expect(run.budget).toMatchObject({ ok: true, max_cost_usd: 2 });
  });

  it("refuses --max-cost below the quote with BUDGET_EXCEEDED", async () => {
    setup({ json: QUOTE }, { maxCost: "1" });
    const error = await preflightCost().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetError);
    expect((error as BudgetError).code).toBe("BUDGET_EXCEEDED");
  });

  it("refuses --max-cost with BUDGET_UNPROVEN when the quote is unavailable", async () => {
    setup({ status: 503, json: { error: { code: "unavailable" } } }, { maxCost: "100" });
    const error = await preflightCost().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetError);
    expect((error as BudgetError).code).toBe("BUDGET_UNPROVEN");
    expect(run.estimate).toMatchObject({ status: "unknown", expected_usd: null });
  });

  it("reports an over-limit verdict on --estimate instead of failing", async () => {
    setup({ json: QUOTE }, { estimate: true, maxCost: "1" });
    expect(await preflightCost()).toBe(true);
    expect(run.budget).toMatchObject({ ok: false, code: "BUDGET_EXCEEDED" });
  });

  it("skips the quote in a plain --dry-run", async () => {
    setup({ json: QUOTE }, { dryRun: true }, true);
    expect(await preflightCost()).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(run.estimate).toBeUndefined();
  });

  it("quotes a normal run so its receipt has an estimate", async () => {
    setup({ json: QUOTE }, {});
    expect(await preflightCost()).toBe(false);
    expect(run.estimate).toMatchObject({ status: "estimated", expected_usd: 1.68 });
    expect(run.calls).toEqual([]);
  });
});
