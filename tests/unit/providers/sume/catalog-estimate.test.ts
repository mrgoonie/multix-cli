import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preflightCost } from "../../../../src/agent/cost-preflight.js";
import { run } from "../../../../src/agent/run-state.js";
import { _resetEnvLoader } from "../../../../src/core/env-loader.js";
import { loadSumeCatalog } from "../../../../src/providers/sume/commands/catalog-cache.js";
import { estimateSumeRun } from "../../../../src/providers/sume/commands/estimate.js";
import { CATALOG_BODY, fakeSume, json, sumeError } from "./fake-sume.js";

let tmp: string;
const originalEnv = { ...process.env };
const BASE = "https://api.sume.com";
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sume-cat-"));
  process.env.MULTIX_CACHE_DIR = tmp;
  process.env.SUME_API_KEY = "";
  _resetEnvLoader();
});

afterEach(() => {
  process.env = { ...originalEnv };
  _resetEnvLoader();
  run.command = "";
  run.options = {};
  run.estimate = undefined;
  run.budget = undefined;
  run.maxCost = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("catalog cache", () => {
  const read = (fetch: typeof globalThis.fetch, now: number, refresh = false) =>
    loadSumeCatalog({ fetch, baseUrl: BASE, dir: tmp, ttlSeconds: 3600, now: () => now, refresh });

  it("reads fresh, then serves the cached copy within the TTL", async () => {
    const { fetch, calls } = fakeSume({ "GET /v1/open/catalog": [json(CATALOG_BODY)] });
    const t0 = Date.UTC(2026, 9, 28);
    expect((await read(fetch, t0)).source.state).toBe("fresh");
    const cached = await read(fetch, t0 + 60_000);
    expect(cached.source.state).toBe("cached");
    expect(cached.source.url).toBe(`${BASE}/v1/open/catalog`);
    expect(cached.models.map((m) => m.id)).toContain("kling-3");
    expect(calls).toHaveLength(1);
  });

  it("falls back to a stale copy when the live read fails, and to unavailable past 7 days", async () => {
    const ok = fakeSume({ "GET /v1/open/catalog": [json(CATALOG_BODY)] });
    const t0 = Date.UTC(2026, 9, 28);
    await read(ok.fetch, t0);
    const down = fakeSume({ "GET /v1/open/catalog": [new Response("x", { status: 503 })] });
    const stale = await read(down.fetch, t0 + 2 * 3600_000);
    expect(stale.source.state).toBe("stale");
    expect(stale.source.error).toBeTruthy();
    const gone = await read(down.fetch, t0 + 8 * DAY);
    expect(gone.source.state).toBe("unavailable");
    expect(gone.models).toEqual([]);
  });

  it("does not use a copy read from another base URL", async () => {
    const ok = fakeSume({ "GET /v1/open/catalog": [json(CATALOG_BODY)] });
    const t0 = Date.UTC(2026, 9, 28);
    await read(ok.fetch, t0);
    const down = fakeSume({ "GET /v1/open/catalog": [new Error("offline")] });
    const other = await loadSumeCatalog({
      fetch: down.fetch,
      baseUrl: "https://sume.example.net",
      dir: tmp,
      ttlSeconds: 3600,
      now: () => t0,
    });
    expect(other.source.state).toBe("unavailable");
  });
});

describe("estimateSumeRun", () => {
  it("prices from the catalog without a key, with source and timestamp", async () => {
    const { fetch, calls } = fakeSume({ "GET /v1/open/catalog": [json(CATALOG_BODY)] });
    const e = await estimateSumeRun("video", "a cat", { model: "kling-3", duration: "5" }, fetch);
    expect(e.status).toBe("estimated");
    expect(e.upper_bound).toBe("estimated");
    expect(e.rate?.source).toBe(`${BASE}/v1/open/catalog`);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("uses the non-billable estimate endpoint with a key (a proven cap)", async () => {
    process.env.SUME_API_KEY = "sk_test";
    _resetEnvLoader();
    const { fetch, calls } = fakeSume({
      "GET /v1/open/catalog": [json(CATALOG_BODY)],
      "POST /v1/open/estimate": [json({ data: { usd_micros: 560000, usd: "0.56" } })],
    });
    const e = await estimateSumeRun("video", "a cat", { model: "kling-3", duration: "5" }, fetch);
    expect(e.upper_bound).toBe("proven");
    expect(e.high_usd).toBe(0.56);
    expect(e.rate?.source).toBe(`${BASE}/v1/open/estimate`);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ model: "kling-3", input: { prompt: "a cat", duration: 5 } });
  });

  it("falls back to the catalog price when the estimate endpoint fails", async () => {
    process.env.SUME_API_KEY = "sk_test";
    _resetEnvLoader();
    const { fetch } = fakeSume({
      "GET /v1/open/catalog": [json(CATALOG_BODY)],
      "POST /v1/open/estimate": [sumeError(401, "invalid_api_key", "bad key")],
    });
    const e = await estimateSumeRun("image", "a fox", { model: "seedream-v4" }, fetch);
    expect(e.upper_bound).toBe("estimated");
    expect(e.assumptions.join(" ")).toMatch(/estimate endpoint failed/);
  });
});

describe("--max-cost preflight", () => {
  it("fails closed under strict policy on a catalog-only estimate", async () => {
    const { fetch } = fakeSume({ "GET /v1/open/catalog": [json(CATALOG_BODY)] });
    const original = globalThis.fetch;
    globalThis.fetch = fetch;
    try {
      run.command = "sume image";
      run.options = { model: "seedream-v4", maxCost: "5" };
      await expect(preflightCost(["a fox"])).rejects.toMatchObject({ code: "BUDGET_UNPROVEN" });
      run.options = { model: "seedream-v4", estimate: true };
      expect(await preflightCost(["a fox"])).toBe(true);
      expect(run.estimate?.high_usd).toBe(0.03);
    } finally {
      globalThis.fetch = original;
    }
  });
});
