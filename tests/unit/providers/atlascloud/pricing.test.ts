/**
 * Atlas Cloud 3D prices: reading the live model and price lists, pricing a
 * run (estimate, --max-cost, actual cost), and the catalogue rate cards.
 * fetch is stubbed with fixtures shaped like Atlas's public responses; no network.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { costReceiptFor, preflightCost } from "../../../../src/agent/cost-preflight.js";
import { run } from "../../../../src/agent/run-state.js";
import { checkBudget, estimateCommand } from "../../../../src/budget/command-cost.js";
import { buildCostReceipt } from "../../../../src/budget/cost-receipt.js";
import { buildOfferings } from "../../../../src/catalog/catalog-build.js";
import { registerCommands } from "../../../../src/commands/index.js";
import {
  ATLAS_MODELS_URL,
  ATLAS_PRICING_URL,
  type Atlas3dPriceSnapshot,
  atlas3dRateCards,
  estimateAtlas3dCost,
  listedPriceOf,
  readAtlas3dCatalog,
} from "../../../../src/providers/atlascloud/pricing.js";

const AT = new Date("2026-11-12T00:00:00Z");
const MESHY = "meshy-v7/image-to-3d";
const HI3D = "hi3d/v3.0-master/image-to-3d";
const PRO = "tencent/hunyuan3d-pro/image-to-3d";
const RAPID = "tencent/hunyuan3d-rapid/image-to-3d";

/** GET /models: base_price is NOT the run price (Hi3D lists 0.017 and bills $5.185). */
const MODELS_BODY = {
  data: [
    { model: MESHY, displayName: "Meshy v7", categories: ["IMAGE-TO-3D"] },
    { model: HI3D, displayName: "Hi3D v3.0 Master", categories: ["IMAGE-TO-3D"] },
    { model: PRO, categories: ["IMAGE-TO-3D"] },
    { model: RAPID, categories: ["IMAGE-TO-3D"] },
    { model: "tencent/hunyuan3d-rapid/text-to-3d", categories: ["TEXT-TO-3D"] },
    { model: "vendor/unpriced/image-to-3d", categories: ["IMAGE-TO-3D"] },
    { model: "black-forest-labs/flux-schnell", categories: ["TEXT-TO-IMAGE"] },
  ].map((m) => ({ ...m, price: { actual: { base_price: 0.017 } } })),
};

const row = (id: string, label: string, price: string, defaults?: Record<string, unknown>) => ({
  row_id: id,
  model_label: label,
  billing_unit: "/pic",
  our_price: price,
  official_price: price,
  requires_quote: defaults !== undefined,
  ...(defaults ? { quote_defaults: defaults } : {}),
});

/** GET /pricing/models, trimmed to the fields multix reads. */
const PRICING_BODY = {
  data: [
    {
      id: MESHY,
      price_rows: [
        row("tf-uf", "Texture off, Ultra off", "0.44", {
          should_texture: false,
          ultra_mode: false,
        }),
        row("tt-uf", "Texture on, Ultra off", "0.66", { should_texture: true, ultra_mode: false }),
        row("tf-ut", "Texture off, Ultra on", "0.55", { should_texture: false, ultra_mode: true }),
        row("tt-ut", "Texture on, Ultra on", "0.77", { should_texture: true, ultra_mode: true }),
      ],
      pricing: { request: "0.66" },
      pricing_params: ["should_texture", "texture_resolution", "ultra_mode"],
      requires_runtime_quote: true,
    },
    {
      id: HI3D,
      price_rows: [row("standard", "Standard", "5.185")],
      pricing: { request: "5.185" },
      pricing_params: null,
      requires_runtime_quote: false,
    },
    {
      id: PRO,
      price_rows: [
        row("g-0", "Geometry · Default face count", "0.3", {
          generate_type: "Geometry",
          enable_pbr: false,
          face_count: 0,
        }),
        row("g-1", "Geometry · Custom face count", "0.5", {
          generate_type: "Geometry",
          enable_pbr: false,
          face_count: 1,
        }),
        row("n-0", "Normal · Default face count", "0.5", {
          generate_type: "Normal",
          enable_pbr: false,
          face_count: 0,
        }),
        row("n-1", "Normal · Custom face count", "0.7", {
          generate_type: "Normal",
          enable_pbr: false,
          face_count: 1,
        }),
      ],
      pricing: { request: "0.5" },
      pricing_params: ["generate_type", "enable_pbr", "face_count"],
      requires_runtime_quote: true,
    },
    {
      id: RAPID,
      price_rows: [row("standard", "Standard", "0.3")],
      pricing: { request: "0.3" },
      requires_runtime_quote: false,
    },
    { id: "vendor/unpriced/image-to-3d", price_rows: [{ row_id: "x", our_price: "n/a" }] },
  ],
};

function stubAtlas(fail = false) {
  const calls: string[] = [];
  const fn = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (fail) throw new TypeError("fetch failed");
    if (url === ATLAS_PRICING_URL) return new Response(JSON.stringify(PRICING_BODY));
    if (url === ATLAS_MODELS_URL) return new Response(JSON.stringify(MODELS_BODY));
    return new Response("{}", { status: 404 });
  };
  return { calls, fn: fn as typeof fetch };
}

async function snapshot(): Promise<Atlas3dPriceSnapshot> {
  const { models } = await readAtlas3dCatalog(stubAtlas().fn);
  return { fetched_at: "2026-11-11T00:00:00.000Z", models };
}

describe("readAtlas3dCatalog", () => {
  it("keeps the 3D models and prices them from the price list, not base_price", async () => {
    const { url, models } = await readAtlas3dCatalog(stubAtlas().fn);
    expect(url).toBe(ATLAS_PRICING_URL);
    expect(models.map((m) => m.model)).toEqual([
      MESHY,
      HI3D,
      PRO,
      RAPID,
      "tencent/hunyuan3d-rapid/text-to-3d",
      "vendor/unpriced/image-to-3d",
    ]);
    const meshy = models.find((m) => m.model === MESHY);
    expect(meshy?.pricing).toEqual({
      default_usd: "0.66",
      min_usd: "0.44",
      max_usd: "0.77",
      unit: "/pic",
    });
    expect(meshy?.price).toMatchObject({ default_usd: 0.66, quoted_at_run: true });
    expect(models.find((m) => m.model === HI3D)?.price).toMatchObject({
      default_usd: 5.185,
      quoted_at_run: false,
      rows: [{ id: "standard", usd: 5.185 }],
    });
    // Listed without a price: neither unpriced nor missing from the price list.
    expect(models.find((m) => m.model === "vendor/unpriced/image-to-3d")?.price).toBeUndefined();
    expect(models.find((m) => m.model.endsWith("text-to-3d"))?.price).toBeUndefined();
  });

  it("refuses a response without a data list", async () => {
    const bad = (async () => new Response("{}")) as unknown as typeof fetch;
    await expect(readAtlas3dCatalog(bad)).rejects.toThrow(/no data list/);
  });

  it("ignores rows without a numeric price", () => {
    expect(listedPriceOf({ price_rows: [{ our_price: "-1" }, { our_price: "" }] })).toBeUndefined();
  });
});

describe("estimateAtlas3dCost", () => {
  it("prices atlas 3d at the model's default-settings list price", async () => {
    const e = estimateAtlas3dCost({
      command: "atlas 3d",
      model: MESHY,
      prices: await snapshot(),
      at: AT,
    });
    expect(e).toMatchObject({
      status: "estimated",
      low_usd: 0.66,
      expected_usd: 0.66,
      high_usd: 0.66,
      upper_bound: "estimated",
      rate: { label: "Atlas Cloud list price", source: "https://www.atlascloud.ai/pricing/models" },
    });
    expect(e.assumptions.join(" ")).toMatch(/quotes the final price at submit time/);
  });

  it("narrows to the rows the request's settings select", async () => {
    const e = estimateAtlas3dCost({
      command: "atlas run",
      model: MESHY,
      input: { should_texture: false, ultra_mode: true },
      prices: await snapshot(),
      at: AT,
    });
    expect(e).toMatchObject({ low_usd: 0.55, high_usd: 0.55, upper_bound: "estimated" });
    const partial = estimateAtlas3dCost({
      command: "atlas run",
      model: MESHY,
      input: { should_texture: true },
      prices: await snapshot(),
      at: AT,
    });
    expect(partial).toMatchObject({ low_usd: 0.66, expected_usd: 0.66, high_usd: 0.77 });
  });

  it("says when a numeric setting is not pinned by the listed rows", async () => {
    const e = estimateAtlas3dCost({
      command: "atlas run",
      model: PRO,
      input: { generate_type: "normal", face_count: 200000 },
      prices: await snapshot(),
      at: AT,
    });
    expect(e).toMatchObject({ low_usd: 0.5, high_usd: 0.7, upper_bound: "estimated" });
    expect(e.assumptions.join(" ")).toMatch(/do not pin face_count/);
  });

  it("proves the cap for a single price Atlas does not re-quote", async () => {
    const e = estimateAtlas3dCost({
      command: "atlas 3d",
      model: HI3D,
      prices: await snapshot(),
      at: AT,
    });
    expect(e).toMatchObject({ high_usd: 5.185, upper_bound: "proven" });
  });

  it("is unknown (never $0) without a usable price list", async () => {
    const prices = await snapshot();
    expect(estimateAtlas3dCost({ command: "atlas 3d", model: MESHY, at: AT })).toMatchObject({
      status: "unknown",
      reason: "no_price",
      high_usd: null,
    });
    const stale = { ...prices, fetched_at: "2026-10-01T00:00:00Z" };
    expect(
      estimateAtlas3dCost({ command: "atlas 3d", model: MESHY, prices: stale, at: AT }),
    ).toMatchObject({ status: "unknown", reason: "stale" });
    expect(
      estimateAtlas3dCost({
        command: "atlas run",
        model: "black-forest-labs/flux-schnell",
        prices,
        at: AT,
      }),
    ).toMatchObject({ status: "unknown", reason: "unsupported" });
    expect(
      estimateAtlas3dCost({
        command: "atlas 3d",
        model: "vendor/unpriced/image-to-3d",
        prices,
        at: AT,
      }),
    ).toMatchObject({ status: "unknown", reason: "no_price" });
  });
});

describe("estimateCommand and --max-cost", () => {
  it("picks atlas 3d's default model from --ref and parses an inline atlas run --input", async () => {
    const atlas3dPrices = await snapshot();
    const withRef = estimateCommand("atlas 3d", { ref: ["a.png"] }, { atlas3dPrices, at: AT });
    expect(withRef).toMatchObject({ model: RAPID, high_usd: 0.3, upper_bound: "proven" });
    const runEst = estimateCommand(
      "atlas run",
      { input: '{"should_texture":false,"ultra_mode":false}' },
      { model: MESHY, atlas3dPrices, at: AT },
    );
    expect(runEst).toMatchObject({ model: MESHY, high_usd: 0.44 });
    // The worker has no price list: unknown, not $0.
    expect(estimateCommand("atlas 3d", { model: MESHY }, { at: AT })).toMatchObject({
      status: "unknown",
      reason: "no_price",
    });
  });

  it("enforces a proven cap strictly and a quoted price only under --cost-policy estimate", async () => {
    const prices = await snapshot();
    const hi3d = estimateAtlas3dCost({ command: "atlas 3d", model: HI3D, prices, at: AT });
    expect(() => checkBudget(hi3d, 6, "strict")).not.toThrow();
    expect(() => checkBudget(hi3d, 5, "strict")).toThrow(/exceeds --max-cost/);
    const meshy = estimateAtlas3dCost({ command: "atlas 3d", model: MESHY, prices, at: AT });
    expect(() => checkBudget(meshy, 1, "strict")).toThrow(
      /Atlas Cloud quotes the final price at submit time.*--cost-policy estimate/,
    );
    expect(() => checkBudget(meshy, 1, "estimate")).not.toThrow();
    expect(() => checkBudget(meshy, 0.5, "estimate")).toThrow(/exceeds --max-cost/);
  });
});

describe("receipts", () => {
  it("reports the list price as the actual cost of a successful run", () => {
    const r = buildCostReceipt({
      operation_id: "op",
      outcome: "ok",
      provider: "atlas",
      calls: [{ method: "POST", status: 200 }],
      list_price: { usd: 0.66, label: "Atlas Cloud list price" },
      at: AT,
    });
    expect(r).toMatchObject({
      status: "computed",
      actual_usd: 0.66,
      actual_source: "computed_from_usage",
      role: "charge",
    });
    expect(r.reason).toMatch(/priced at the Atlas Cloud list price/);
    const failed = buildCostReceipt({
      operation_id: "op",
      outcome: "failed",
      provider: "atlas",
      calls: [{ method: "POST", status: 500 }],
      list_price: { usd: 0.66, label: "Atlas Cloud list price" },
      at: AT,
    });
    expect(failed.actual_usd).not.toBe(0.66);
  });

  it("says a run that failed before submitting sent nothing billable", () => {
    const r = buildCostReceipt({
      operation_id: "op",
      outcome: "failed",
      provider: "atlas",
      calls: [{ method: "GET", status: 200 }],
      at: AT,
    });
    expect(r).toMatchObject({ role: "observation", status: "unknown" });
    expect(r.reason).toMatch(/submitted nothing, so it was not billed/);
  });
});

describe("CLI wiring (cached price list)", () => {
  let tmp: string;
  let stdout: string[];
  const saved = { command: run.command, options: run.options };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-atlas-3d-"));
    vi.stubEnv("MULTIX_CACHE_DIR", tmp);
    stdout = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      stdout.push(a.map(String).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    Object.assign(run, saved);
    run.json = false;
    run.estimate = undefined;
    run.budget = undefined;
    run.maxCost = undefined;
    run.costPolicy = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("prices atlas 3d before it runs, caches the list and reports the actual cost", async () => {
    const atlas = stubAtlas();
    vi.stubGlobal("fetch", atlas.fn);
    run.command = "atlas 3d";
    run.options = { ref: ["a.png"], model: MESHY, estimate: true };
    expect(await preflightCost()).toBe(true);
    expect(run.estimate).toMatchObject({ model: MESHY, high_usd: 0.66 });
    expect(fs.existsSync(path.join(tmp, "models", "atlas-3d.json"))).toBe(true);
    // Second read comes from the cache.
    atlas.calls.length = 0;
    run.options = { ref: ["a.png"], model: HI3D, maxCost: "6" };
    expect(await preflightCost()).toBe(false);
    expect(atlas.calls).toEqual([]);
    expect(run.budget?.ok).toBe(true);
    const saved2 = { group: run.group, calls: run.calls };
    run.group = "atlas";
    run.calls = [{ method: "POST", status: 200 }] as typeof run.calls;
    const receipt = costReceiptFor({ failed: false, notSent: false, model: HI3D });
    Object.assign(run, saved2);
    expect(receipt).toMatchObject({ status: "computed", actual_usd: 5.185 });
  });

  it("never reads the price list for an atlas run that is not 3D unless a price is asked", async () => {
    const atlas = stubAtlas();
    vi.stubGlobal("fetch", atlas.fn);
    run.command = "atlas run";
    run.options = { input: "{}" };
    expect(await preflightCost(["black-forest-labs/flux-schnell"])).toBe(false);
    expect(atlas.calls).toEqual([]);
    expect(run.estimate).toBeUndefined();
    run.options = { input: '{"should_texture":false,"ultra_mode":true}', estimate: true };
    expect(await preflightCost([MESHY])).toBe(true);
    expect(run.estimate).toMatchObject({ model: MESHY, high_usd: 0.55 });
  });

  it("refuses --max-cost when the price list cannot be read", async () => {
    vi.stubGlobal("fetch", stubAtlas(true).fn);
    run.command = "atlas 3d";
    run.options = { maxCost: "1" };
    await expect(preflightCost()).rejects.toThrow(/cost of atlas .* is unknown/);
  });

  async function cli(...args: string[]): Promise<unknown> {
    run.json = true;
    const program = new Command().name("multix").enablePositionalOptions();
    program.exitOverride();
    registerCommands(program);
    stdout = [];
    await program.parseAsync(["node", "multix", ...args]);
    return JSON.parse(stdout.join("\n"));
  }

  it("lists Atlas 3D models with prices under models --task 3d --live", async () => {
    vi.stubGlobal("fetch", stubAtlas().fn);
    const out = (await cli("models", "--task", "3d", "--live", "--provider", "atlas")) as {
      sources: Array<{ provider: string; state: string }>;
      models: Array<{ model: string; provider: string; pricing?: Record<string, string> }>;
    };
    expect(out.sources).toContainEqual(
      expect.objectContaining({ provider: "atlas", state: "fresh" }),
    );
    expect(out.models.find((m) => m.model === MESHY)?.pricing).toMatchObject({ min_usd: "0.44" });
  });

  it("lists Atlas 3D offerings under catalog models --task 3d, and only fetches when 3D is asked", async () => {
    const atlas = stubAtlas();
    vi.stubGlobal("fetch", atlas.fn);
    const none = (await cli("catalog", "models", "--provider", "fal")) as unknown;
    expect(none).toBeDefined();
    expect(atlas.calls).toEqual([]);
    const out = JSON.stringify(await cli("catalog", "models", "--task", "3d"));
    expect(out).toContain(`atlas:${HI3D}`);
    expect(out).toContain("atlas 3d");
    expect(atlas.calls.length).toBeGreaterThan(0);
  });
});

describe("atlas3dRateCards", () => {
  it("makes one per-request card per listed configuration", async () => {
    const cards = atlas3dRateCards((await snapshot()).models, "2026-11-11T00:00:00Z");
    const hi3d = cards.find((c) => c.models[0] === HI3D);
    expect(hi3d).toMatchObject({
      id: `atlas/${HI3D}@api`,
      task: "3d",
      basis: "list",
      last_checked: "2026-11-11",
      windows: [{ components: [{ meter: "requests", usd: 5.185, per: 1 }] }],
    });
    const meshy = cards.filter((c) => c.models[0] === MESHY);
    expect(meshy).toHaveLength(4);
    expect(meshy[0]).toMatchObject({
      basis: "estimated",
      config: { variant: "Texture off, Ultra off" },
    });
    const offerings = buildOfferings(AT, cards);
    expect(offerings.find((o) => o.model === HI3D)).toMatchObject({ command: "atlas 3d" });
  });
});
