/**
 * Atlas Cloud 3D prices: the live price list and quote parsers, the pre-flight
 * estimate built from them, the receipt of a completed run, and the catalogue
 * offerings. No network: every fetch is injected or stubbed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preflightCost } from "../../../../src/agent/cost-preflight.js";
import { run } from "../../../../src/agent/run-state.js";
import { estimateCommand, pricedCommands } from "../../../../src/budget/command-cost.js";
import { buildCostReceipt } from "../../../../src/budget/cost-receipt.js";
import {
  discoveryProvidersFor,
  discoverySupported,
} from "../../../../src/capabilities/model-discovery.js";
import { atlas3dOfferings, mergeOfferings } from "../../../../src/catalog/catalog-build.js";
import { catalogQuery } from "../../../../src/catalog/catalog-query.js";
import type { Offering } from "../../../../src/catalog/catalog-types.js";
import {
  type AtlasPriceSnapshot,
  estimateAtlasCost,
} from "../../../../src/providers/atlascloud/cost.js";
import {
  type Atlas3dModel,
  parseAtlas3dModel,
  parseAtlasQuote,
  parsePriceFields,
  pricingSettings,
  quoteAtlasPrice,
  readAtlas3dCatalog,
} from "../../../../src/providers/atlascloud/pricing.js";

const BASE = "https://api.atlascloud.ai/api/v1";
const AT = new Date("2026-11-12T12:00:00Z");
const HOUR = 3_600_000;

const MESHY = "meshy-v7/image-to-3d";
const HUNYUAN = "tencent/hunyuan3d-rapid/text-to-3d";

const MODEL_LIST = {
  data: [
    { model: MESHY, displayName: "Meshy v7 Image-to-3D", categories: ["IMAGE-TO-3D"] },
    { model: HUNYUAN, displayName: "Hunyuan3D Rapid", categories: ["TEXT-TO-3D"] },
    { model: "hidden/3d", categories: ["TEXT-TO-3D"], display_console: false },
    { model: "some/video", categories: ["TEXT-TO-VIDEO"] },
    { model: "unpriced/3d", categories: ["IMAGE-TO-3D"] },
    { model: MESHY, categories: ["IMAGE-TO-3D"] },
  ],
};

const PRICE_LIST = {
  data: [
    {
      id: MESHY,
      pricing_params: ["should_texture", "enable_pbr", "bad name!"],
      price_rows: [
        { model_label: "Should Texture disabled", our_price: "0.44", billing_unit: "/pic" },
        { model_label: "Should Texture enabled", our_price: 0.66, billing_unit: "/pic" },
        { model_label: "broken", our_price: "abc" },
      ],
    },
    {
      id: HUNYUAN,
      pricing_params: ["enable_pbr"],
      price_rows: [{ model_label: "PBR disabled", our_price: 0.3, billing_unit: "/generation" }],
    },
  ],
};

interface Sent {
  url: string;
  init?: RequestInit;
}

function fakeAtlas(quote: unknown = { code: 200, data: { price: 0.66, estimated: false } }) {
  const sent: Sent[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, ...(init ? { init } : {}) });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url.endsWith("/pricing/calculate")) return json(quote);
    if (url.endsWith("/pricing/models")) return json(PRICE_LIST);
    if (url.endsWith("/models")) return json(MODEL_LIST);
    return json({ msg: "not found" }, 404);
  }) as typeof fetch;
  return { fetchFn, sent };
}

describe("Atlas 3D price list", () => {
  it("reads 3D models with their price rows and pricing fields", async () => {
    const { fetchFn } = fakeAtlas();
    const read = await readAtlas3dCatalog(fetchFn, BASE);
    expect(read.url).toBe(`${BASE}/pricing/models`);
    expect(read.models.map((m) => m.model)).toEqual([MESHY, HUNYUAN, "unpriced/3d"]);
    const meshy = read.models[0] as Atlas3dModel;
    expect(meshy).toMatchObject({
      provider: "atlas",
      task: "3d",
      name: "Meshy v7 Image-to-3D",
      pricing: { usd_per_request_min: "0.44", usd_per_request_max: "0.66" },
      pricing_params: ["should_texture", "enable_pbr"],
    });
    expect(meshy.price_rows).toEqual([
      { label: "Should Texture disabled", usd: 0.44, unit: "/pic" },
      { label: "Should Texture enabled", usd: 0.66, unit: "/pic" },
    ]);
    expect(read.models[1]?.pricing).toEqual({ usd_per_request: "0.3" });
    expect(read.models[2]?.pricing).toBeUndefined();
  });

  it("throws on an HTTP error or a body without a data list", async () => {
    const bad = (async () => new Response("{}", { status: 503 })) as typeof fetch;
    await expect(readAtlas3dCatalog(bad, BASE)).rejects.toThrow(/HTTP 503/);
    const empty = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    await expect(readAtlas3dCatalog(empty, BASE)).rejects.toThrow(/no data list/);
  });

  it("re-parses a cached model and drops odd values", () => {
    expect(parseAtlas3dModel({ provider: "fal", model: "x" })).toBeUndefined();
    const m = parseAtlas3dModel({
      provider: "atlas",
      model: "a\u0007b",
      price_rows: [{ label: "x", usd: -1 }, { label: "y", usd: 1e9 }, { usd: 2 }],
    });
    expect(m).toMatchObject({ model: "ab", price_rows: [{ label: "default", usd: 2, unit: "" }] });
    expect(parsePriceFields(null)).toEqual({});
  });
});

describe("Atlas price quote", () => {
  it("parses a fixed and an estimated quote", () => {
    expect(
      parseAtlasQuote({
        code: 200,
        data: { price: "0.88", estimated: false, price_version: "v1" },
      }),
    ).toEqual({ usd: 0.88, estimated: false, price_version: "v1" });
    // Without an explicit `estimated: false` the price is not treated as fixed.
    expect(parseAtlasQuote({ code: 200, data: { price: 0.5 } }).estimated).toBe(true);
  });

  it("throws when the service gives no price", () => {
    expect(() => parseAtlasQuote({ code: 400, msg: "not found" })).toThrow(
      /no price \(not found\)/,
    );
    expect(() => parseAtlasQuote({ code: 200, data: { price: "n/a" } })).toThrow(/no price/);
  });

  it("sends only the model id and its pricing settings", async () => {
    const { fetchFn, sent } = fakeAtlas();
    const settings = pricingSettings(
      { image_url: "https://e.com/secret.png", should_texture: true, prompt: "private" },
      ["should_texture", "enable_pbr"],
    );
    expect(settings).toEqual({ should_texture: true });
    const quote = await quoteAtlasPrice({ fetchFn, model: MESHY, settings, baseUrl: BASE });
    expect(quote).toEqual({ usd: 0.66, estimated: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`${BASE}/pricing/calculate`);
    expect(sent[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(sent[0]?.init?.body))).toEqual({ should_texture: true, model: MESHY });
    expect(new Headers(sent[0]?.init?.headers).get("authorization")).toBeNull();
  });

  it("reports a non-JSON error response", async () => {
    const fetchFn = (async () => new Response("oops", { status: 502 })) as typeof fetch;
    await expect(quoteAtlasPrice({ fetchFn, model: MESHY })).rejects.toThrow(/HTTP 502/);
  });
});

const LISTED: Atlas3dModel = {
  provider: "atlas",
  model: MESHY,
  task: "3d",
  price_rows: [
    { label: "Should Texture disabled", usd: 0.44, unit: "/pic" },
    { label: "Should Texture enabled", usd: 0.66, unit: "/pic" },
  ],
};

function snapshot(over: Partial<AtlasPriceSnapshot> = {}): AtlasPriceSnapshot {
  return {
    fetched_at: new Date(AT.getTime() - HOUR).toISOString(),
    model: LISTED,
    quote: { usd: 0.66, estimated: false },
    settings: {},
    ...over,
  };
}

describe("Atlas 3D estimate", () => {
  const est = (command: string, model: string, snap?: AtlasPriceSnapshot) =>
    estimateAtlasCost({ command, model, ...(snap ? { snapshot: snap } : {}), at: AT });

  it("is a proven ceiling at Atlas's fixed quote", () => {
    const e = est("atlas 3d", MESHY, snapshot());
    expect(e).toMatchObject({
      status: "estimated",
      provider: "atlas",
      model: MESHY,
      low_usd: 0.66,
      expected_usd: 0.66,
      high_usd: 0.66,
      upper_bound: "proven",
      units: { requests: { low: 1, expected: 1, high: 1 } },
      rate: { id: `atlas/${MESHY}@quote`, components: [{ meter: "requests", usd: 0.66, per: 1 }] },
    });
    expect(e.assumptions.join(" ")).toMatch(/default settings/);
    expect(e.assumptions.join(" ")).toMatch(/Should Texture enabled \$0.66/);
  });

  it("names the quoted settings and keeps an estimated quote unproven", () => {
    const e = est(
      "atlas run",
      MESHY,
      snapshot({ quote: { usd: 0.88, estimated: true }, settings: { should_texture: true } }),
    );
    expect(e).toMatchObject({ high_usd: 0.88, upper_bound: "estimated" });
    expect(e.assumptions[0]).toMatch(/should_texture=true; Atlas marks it as an estimate/);
  });

  it("is unknown, never $0, without a usable list or quote", () => {
    expect(est("atlas 3d", "", snapshot())).toMatchObject({
      status: "unknown",
      reason: "missing_input",
    });
    expect(est("atlas 3d", MESHY)).toMatchObject({ status: "unknown", reason: "no_price" });
    expect(est("atlas 3d", MESHY, { error: "HTTP 503" }).detail).toMatch(/HTTP 503/);
    const old = new Date(AT.getTime() - 25 * HOUR).toISOString();
    expect(est("atlas 3d", MESHY, snapshot({ fetched_at: old }))).toMatchObject({
      status: "unknown",
      reason: "stale",
      high_usd: null,
    });
    expect(est("atlas 3d", "other/3d", snapshot({ model: undefined }))).toMatchObject({
      reason: "no_price",
    });
    expect(est("atlas run", "some/video", snapshot({ model: undefined }))).toMatchObject({
      reason: "unsupported",
    });
    expect(est("atlas 3d", MESHY, snapshot({ quote: undefined, error: "timeout" }))).toMatchObject({
      status: "unknown",
      reason: "no_price",
    });
  });

  it("is routed from the shared command estimator", () => {
    expect(pricedCommands()).toEqual(expect.arrayContaining(["atlas 3d", "atlas run"]));
    const viaFlag = estimateCommand("atlas 3d", { model: MESHY }, { atlasPrice: snapshot() });
    expect(viaFlag).toMatchObject({ status: "estimated", model: MESHY });
    // `atlas run` takes its model from the positional argument the caller resolved.
    const viaRun = estimateCommand("atlas run", {}, { model: MESHY, atlasPrice: snapshot() });
    expect(viaRun).toMatchObject({ status: "estimated", model: MESHY });
    // A caller without a snapshot (the MCP Worker) gets unknown.
    expect(estimateCommand("atlas 3d", { model: MESHY }, {})).toMatchObject({ status: "unknown" });
  });
});

describe("Atlas 3D receipt", () => {
  const POST = { method: "POST", status: 200 };
  const GET = { method: "GET", status: 200 };
  const base = { operation_id: "op", provider: "atlas", model: MESHY, at: AT };

  it("computes a completed run at the fixed quote", () => {
    const r = buildCostReceipt({
      ...base,
      outcome: "ok",
      calls: [GET, POST, GET],
      fixed_price_usd: 0.66,
    });
    expect(r).toMatchObject({
      role: "charge",
      status: "computed",
      actual_usd: 0.66,
      actual_source: "computed_from_usage",
    });
  });

  it("keeps a failed run uncertain even with a fixed quote", () => {
    const r = buildCostReceipt({
      ...base,
      outcome: "failed",
      calls: [POST],
      fixed_price_usd: 0.66,
    });
    expect(r).toMatchObject({ status: "uncertain", actual_usd: null });
  });

  it("says nothing was submitted when a run failed after reads only", () => {
    const r = buildCostReceipt({ ...base, outcome: "failed", calls: [GET], fixed_price_usd: 0.66 });
    expect(r.role).toBe("observation");
    expect(r.reason).toMatch(/nothing was submitted/);
  });
});

describe("Atlas 3D catalogue offerings", () => {
  const fresh = new Date(AT.getTime() - HOUR).toISOString();

  it("lists each price row as a current per-request rate", () => {
    const [o] = atlas3dOfferings([{ ...LISTED, name: "Meshy v7" }], fresh, AT);
    expect(o).toMatchObject({
      id: `atlas:${MESHY}`,
      provider: "atlas",
      tasks: ["3d"],
      command: "atlas 3d",
      verified_capability: false,
      price_status: "priced",
    });
    expect(o?.rates.map((r) => [r.status, r.config.variant, r.components?.[0]?.usd])).toEqual([
      ["current", "Should Texture disabled", 0.44],
      ["current", "Should Texture enabled", 0.66],
    ]);
  });

  it("marks a list older than 24h stale and an unpriced model no_price", () => {
    const old = new Date(AT.getTime() - 25 * HOUR).toISOString();
    const [stale] = atlas3dOfferings([LISTED], old, AT);
    expect(stale?.price_status).toBe("stale");
    expect(stale?.rates[0]?.components).toBeUndefined();
    const [none] = atlas3dOfferings([{ provider: "atlas", model: "x/3d", task: "3d" }], fresh, AT);
    expect(none?.price_status).toBe("no_price");
  });

  it("merges into the static catalogue and its views", () => {
    const live = atlas3dOfferings([LISTED], fresh, AT);
    const merged = mergeOfferings([], live);
    expect(merged.map((o) => o.id)).toEqual([`atlas:${MESHY}`]);
    const extra: Offering = { ...(live[0] as Offering), rates: [] };
    const both = mergeOfferings([extra], live);
    expect(both).toHaveLength(1);
    expect(both[0]?.rates).toHaveLength(2);
    const payload = catalogQuery(
      { view: "models", task: "3d", priced: true, sort: "price", at: AT },
      () => true,
      [],
      undefined,
      live,
    ) as { offerings: Offering[] };
    expect(payload.offerings.map((o) => o.id)).toContain(`atlas:${MESHY}`);
    // Without live offerings (the MCP Worker), nothing changes.
    const plain = catalogQuery({ view: "models", task: "3d", at: AT }, () => true, []) as {
      offerings: Offering[];
    };
    expect(plain.offerings.some((o) => o.id === `atlas:${MESHY}`)).toBe(false);
  });

  it("discovers Atlas for 3D only", () => {
    expect(discoverySupported("atlas", "3d")).toBe(true);
    expect(discoverySupported("atlas", "image")).toBe(false);
    expect(discoveryProvidersFor("3d")).toContain("atlas");
    expect(discoveryProvidersFor("image")).not.toContain("atlas");
  });
});

describe("Atlas 3D preflight", () => {
  const saved = { command: run.command, options: run.options, dryRun: run.dryRun };
  let tmp: string;
  let sent: Sent[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-atlas-price-"));
    vi.stubEnv("MULTIX_CACHE_DIR", tmp);
    vi.stubEnv("MULTIX_MODELS_TTL", "");
    const fake = fakeAtlas();
    sent = fake.sent;
    vi.stubGlobal("fetch", fake.fetchFn);
  });

  afterEach(() => {
    Object.assign(run, saved);
    run.estimate = undefined;
    run.budget = undefined;
    run.maxCost = undefined;
    run.costPolicy = undefined;
    run.fixedPriceUsd = undefined;
    run.operands = undefined;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("prices `atlas 3d`, enforces --max-cost and fixes the completed run's price", async () => {
    run.command = "atlas 3d";
    run.options = { model: MESHY, maxCost: "0.5", ref: ["https://e.com/a.png"] };
    await expect(preflightCost()).rejects.toThrow(/exceeds --max-cost/);
    expect(run.estimate).toMatchObject({ high_usd: 0.66, upper_bound: "proven" });
    run.options = { model: MESHY, maxCost: "1", ref: ["https://e.com/a.png"] };
    expect(await preflightCost()).toBe(false);
    expect(run.budget?.ok).toBe(true);
    expect(run.fixedPriceUsd).toBe(0.66);
    // The list is cached: the second run asked for a quote only.
    expect(sent.filter((s) => s.url.endsWith("/v1/models")).length).toBe(1);
    expect(fs.existsSync(path.join(tmp, "models", "atlas-3d.json"))).toBe(true);
  });

  it("does not fix the price of an --async run", async () => {
    run.command = "atlas 3d";
    run.options = { model: MESHY, async: true };
    await preflightCost();
    expect(run.estimate?.status).toBe("estimated");
    expect(run.fixedPriceUsd).toBeUndefined();
  });

  it("quotes `atlas run` with the --input pricing fields only", async () => {
    run.command = "atlas run";
    run.operands = [MESHY];
    run.options = {
      estimate: true,
      input: JSON.stringify({ image_url: "https://e.com/a.png", should_texture: true }),
    };
    expect(await preflightCost()).toBe(true);
    expect(run.estimate).toMatchObject({ status: "estimated", model: MESHY });
    const quote = sent.find((s) => s.url.endsWith("/pricing/calculate"));
    expect(JSON.parse(String(quote?.init?.body))).toEqual({ should_texture: true, model: MESHY });
  });

  it("keeps no estimate for a non-3D `atlas run` unless asked", async () => {
    run.command = "atlas run";
    run.operands = ["some/video"];
    run.options = { input: "{}" };
    await preflightCost();
    expect(run.estimate).toBeUndefined();
    run.options = { input: "{}", estimate: true };
    await preflightCost();
    expect(run.estimate).toMatchObject({ status: "unknown", reason: "unsupported" });
  });

  it("sends nothing on a dry run", async () => {
    run.command = "atlas 3d";
    run.dryRun = true;
    run.options = { model: MESHY, dryRun: true };
    await preflightCost();
    expect(sent).toHaveLength(0);
    expect(run.estimate).toMatchObject({ status: "unknown" });
  });
});
