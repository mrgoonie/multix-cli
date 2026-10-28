/**
 * The cached Sume catalog (fresh, cached, stale, unavailable) and the
 * pre-flight price built from it: proven, estimated, unknown and stale.
 * `--max-cost` goes through the shared command-cost guard. No network.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preflightCost } from "../../../../src/agent/cost-preflight.js";
import { run } from "../../../../src/agent/run-state.js";
import {
  checkBudget,
  estimateCommand,
  pricedCommands,
} from "../../../../src/budget/command-cost.js";
import { SumeClient } from "../../../../src/providers/sume/client.js";
import { estimateSumeCost } from "../../../../src/providers/sume/cost.js";
import { parseCatalog } from "../../../../src/providers/sume/models.js";
import {
  SUME_CATALOG_CACHE_SCHEMA,
  loadSumeCatalog,
  readSumeCatalogCache,
  sumeCatalogSnapshot,
  writeSumeCatalogCache,
} from "../../../../src/providers/sume/node-catalog.js";
import {
  BASE,
  LAYERED,
  NANO,
  SEEDANCE,
  SEEDREAM,
  VEO,
  catalogBody,
  createFakeSume,
} from "./fake-sume.js";

const CATALOG_URL = `${BASE}/v1/open/catalog`;
const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-28T09:00:00.000Z");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-sume-catalog-"));
  vi.stubEnv("MULTIX_CACHE_DIR", tmp);
  vi.stubEnv("SUME_BASE_URL", BASE);
  vi.stubEnv("SUME_IMAGE_MODEL", "");
  vi.stubEnv("SUME_VIDEO_MODEL", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function clientWith(routes: Parameters<typeof createFakeSume>[0]) {
  const fake = createFakeSume(routes);
  return { fake, client: new SumeClient({ baseUrl: BASE, fetch: fake.fetch }) };
}

function seedCache(ageMs: number, rows: unknown[] = [NANO, VEO]) {
  writeSumeCatalogCache(
    CATALOG_URL,
    parseCatalog(catalogBody(rows)),
    new Date(NOW - ageMs).toISOString(),
  );
}

describe("catalog cache", () => {
  const load = (client: SumeClient, opts: { refresh?: boolean } = {}) =>
    loadSumeCatalog({
      client,
      freshForMs: 24 * HOUR,
      staleForMs: 7 * 24 * HOUR,
      now: () => NOW,
      ...opts,
    });

  it("fetches, caches, then serves the copy within the TTL", async () => {
    const { fake, client } = clientWith({ "GET /v1/open/catalog": [{ json: catalogBody() }] });
    const first = await load(client);
    expect(first.state).toBe("fresh");
    expect(first.fetched_at).toBe(new Date(NOW).toISOString());
    const second = await load(client);
    expect(second.state).toBe("cached");
    expect(second.catalog.models.map((m) => m.id)).toEqual(first.catalog.models.map((m) => m.id));
    expect(fake.calls).toHaveLength(1);
    await load(client, { refresh: true });
    expect(fake.calls).toHaveLength(2);
  });

  it("falls back to an old copy marked stale, or fails as unavailable", async () => {
    const offline = { "GET /v1/open/catalog": [{ throws: new TypeError("fetch failed") }] };
    const { client } = clientWith(offline);
    await expect(load(client)).rejects.toThrow(/Sume model catalog unavailable/);
    seedCache(48 * HOUR);
    const stale = await load(client);
    expect(stale.state).toBe("stale");
    expect(stale.error).toMatch(/Network error/);
    seedCache(8 * 24 * HOUR);
    await expect(load(client)).rejects.toThrow(/too old to use/);
  });

  it("ignores a copy for another URL or schema, and re-parses (and drops) edited rows", () => {
    seedCache(HOUR);
    expect(readSumeCatalogCache(CATALOG_URL)?.models).toHaveLength(2);
    expect(readSumeCatalogCache("https://other.test/v1/open/catalog")).toBeUndefined();
    const file = path.join(tmp, "models", "sume-catalog.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...data,
        models: [
          ...data.models,
          { id: "evil\u001b[2J", kind: "image" },
          { id: "x", kind: "image", name: "a\u0007b" },
        ],
      }),
    );
    expect(readSumeCatalogCache(CATALOG_URL)?.models.map((m) => [m.id, m.name])).toEqual([
      ["nano-banana-2.1", undefined],
      ["veo-3.1", undefined],
      ["x", "ab"],
    ]);
    fs.writeFileSync(file, JSON.stringify({ ...data, schema: "other" }));
    expect(readSumeCatalogCache(CATALOG_URL)).toBeUndefined();
    expect(data.schema).toBe(SUME_CATALOG_CACHE_SCHEMA);
  });

  it("gives the pre-flight snapshot of one model", () => {
    expect(sumeCatalogSnapshot("veo-3.1")).toBeUndefined();
    seedCache(HOUR);
    expect(sumeCatalogSnapshot("veo-3.1")).toMatchObject({
      source: CATALOG_URL,
      model: { id: "veo-3.1" },
    });
    expect(sumeCatalogSnapshot("missing")?.model).toBeUndefined();
  });
});

describe("estimateSumeCost", () => {
  const at = new Date(NOW);
  const snap = (raw: unknown, ageMs = HOUR) => ({
    fetched_at: new Date(NOW - ageMs).toISOString(),
    source: CATALOG_URL,
    model: parseCatalog(catalogBody([raw])).models[0],
  });

  it("proves the ceiling with one price option and known units (rounded up to the cent)", () => {
    const e = estimateSumeCost({
      command: "image",
      model: "seedream-4-5-edit",
      options: { numImages: "3" },
      catalog: snap(SEEDREAM),
      at,
    });
    expect(e).toMatchObject({
      status: "estimated",
      upper_bound: "proven",
      low_usd: 0.12,
      expected_usd: 0.12,
      high_usd: 0.12,
    });
    expect(e.rate).toMatchObject({
      id: "sume/seedream-4-5-edit",
      source: CATALOG_URL,
      last_checked: snap(SEEDREAM).fetched_at,
    });
    expect(e.assumptions[0]).toBe("Billed units: 3 images.");
  });

  it("narrows options by resolution and audio", () => {
    const e = estimateSumeCost({
      command: "video",
      model: "veo-3.1",
      options: { duration: "8", resolution: "1080p", "generate-audio": true },
      catalog: snap(VEO),
      at,
    });
    expect(e).toMatchObject({ upper_bound: "proven", low_usd: 3.2, high_usd: 3.2 });
    const image = estimateSumeCost({
      command: "image",
      model: "nano-banana-2.1",
      options: { resolution: "4K", numImages: "2" },
      catalog: snap(NANO),
      at,
    });
    expect(image).toMatchObject({ upper_bound: "proven", high_usd: 0.23 });
  });

  it("estimates a range when the duration or the option is open", () => {
    const veo = estimateSumeCost({
      command: "video",
      model: "veo-3.1",
      options: {},
      catalog: snap(VEO),
      at,
    });
    expect(veo).toMatchObject({
      status: "estimated",
      upper_bound: "estimated",
      low_usd: 0.8,
      expected_usd: 3.2,
      high_usd: 3.2,
    });
    expect(veo.assumptions[0]).toBe("Billed units: 4-8s (--duration not set).");
    const seedance = estimateSumeCost({
      command: "video",
      model: "seedance-2",
      options: { duration: "5" },
      catalog: snap(SEEDANCE),
      at,
    });
    expect(seedance).toMatchObject({ upper_bound: "estimated", low_usd: 0.36, high_usd: 1.93 });
    const nano = estimateSumeCost({
      command: "image",
      model: "nano-banana-2.1",
      options: {},
      catalog: snap(NANO),
      at,
    });
    expect(nano).toMatchObject({ upper_bound: "estimated", low_usd: 0.04, high_usd: 0.12 });
  });

  it("uses a required field's default for the units (layered: 2 images)", () => {
    const e = estimateSumeCost({
      command: "image",
      model: "qwen-image-layered",
      options: { image: ["a.png"] },
      catalog: snap(LAYERED),
      at,
    });
    expect(e).toMatchObject({ upper_bound: "proven", high_usd: 0.1 });
  });

  it.each([
    [
      "no cache",
      undefined,
      "nano-banana-2.1",
      {},
      "no_price",
      /No cached Sume catalog.*multix sume models --refresh/,
    ],
    [
      "a stale cache",
      snap(NANO, 25 * HOUR),
      "nano-banana-2.1",
      {},
      "stale",
      /older than 24h.*--refresh/,
    ],
    ["no model", snap(NANO), "", {}, "missing_input", /without --model \(or SUME_IMAGE_MODEL\)/],
    [
      "a model the cache lacks",
      snap(NANO),
      "other-model",
      {},
      "no_price",
      /does not list other-model/,
    ],
    [
      "invalid flags",
      snap(NANO),
      "nano-banana-2.1",
      { resolution: "8K" },
      "missing_input",
      /--resolution 8K/,
    ],
  ])("is unknown (never $0) with %s", (_name, catalog, model, options, reason, detail) => {
    const e = estimateSumeCost({ command: "image", model, options, catalog, at });
    expect(e).toMatchObject({ status: "unknown", reason, high_usd: null, upper_bound: "none" });
    expect(e.detail).toMatch(detail);
  });
});

describe("command-cost and the pre-flight", () => {
  it("lists sume image|video as priced and routes them; the Worker (no cache) gets unknown", () => {
    expect(pricedCommands()).toEqual(expect.arrayContaining(["sume image", "sume video"]));
    const e = estimateCommand("sume video", { "--model": "veo-3.1" });
    expect(e).toMatchObject({
      status: "unknown",
      reason: "no_price",
      provider: "sume",
      model: "veo-3.1",
    });
    expect(() => checkBudget(e, 1, "strict")).toThrow(/cost of sume veo-3.1 is unknown/);
  });

  describe("preflightCost", () => {
    const saved = { command: run.command, options: run.options };
    afterEach(() => {
      Object.assign(run, saved);
      run.estimate = undefined;
      run.budget = undefined;
      run.maxCost = undefined;
      run.costPolicy = undefined;
    });

    it("prices from the cached row and enforces --max-cost", () => {
      writeSumeCatalogCache(
        CATALOG_URL,
        parseCatalog(catalogBody([SEEDREAM])),
        new Date().toISOString(),
      );
      run.command = "sume image";
      run.options = { model: "seedream-4-5-edit", numImages: "2", maxCost: "0.05" };
      expect(() => preflightCost()).toThrow(/exceeds --max-cost/);
      expect(run.estimate).toMatchObject({
        status: "estimated",
        upper_bound: "proven",
        high_usd: 0.08,
      });
      run.options = { model: "seedream-4-5-edit", numImages: "2", maxCost: "0.10" };
      expect(preflightCost()).toBe(false);
      expect(run.budget?.ok).toBe(true);
    });

    it("reads the env default model", () => {
      writeSumeCatalogCache(
        CATALOG_URL,
        parseCatalog(catalogBody([SEEDREAM])),
        new Date().toISOString(),
      );
      vi.stubEnv("SUME_IMAGE_MODEL", "seedream-4-5-edit");
      run.command = "sume image";
      run.options = { estimate: true };
      expect(preflightCost()).toBe(true);
      expect(run.estimate).toMatchObject({ model: "seedream-4-5-edit", high_usd: 0.04 });
    });
  });
});
