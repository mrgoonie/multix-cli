import { describe, expect, it } from "vitest";
import { catalogQuery } from "../../src/catalog/catalog-query.js";
import { modelCatalogPayload } from "../src/jobs/model-catalog-view.js";
import { ATLAS_KEY, REPLICATE_KEY, callTool, fullEnv } from "./helpers.js";

// biome-ignore lint/suspicious/noExplicitAny: JSON payloads are untyped in tests
type Json = any;

const SEEDANCE = "fal:bytedance/seedance-2.5/text-to-video";

describe("multix_model_catalog", () => {
  it("quotes one exact request and ranks only confirmed prices", async () => {
    const result = await callTool(fullEnv(), "multix_model_catalog", {
      view: "compare",
      task: "video",
      resolution: "720p",
      duration_s: 10,
      audio: true,
      aspect_ratio: "16:9",
    });
    expect(result.isError).toBeFalsy();
    const rows = result.structuredContent.comparison.rows as Json[];
    const seedance = rows.find((r) => r.offering === SEEDANCE && r.price_rank !== undefined);
    expect(seedance?.total_usd).toBeCloseTo(4.6224, 4);
    for (const r of rows) {
      if (r.price_rank !== undefined) expect(r.total_usd).toBeGreaterThan(0);
    }
    const text = result.content[0].text as string;
    expect(text).not.toContain(REPLICATE_KEY);
    expect(text).not.toContain(ATLAS_KEY);
  });

  it("marks providers ready from the saved keys without returning them", async () => {
    const result = await callTool(fullEnv(), "multix_model_catalog", { view: "providers" });
    const providers = result.structuredContent.providers as Json[];
    expect(providers.find((p) => p.id === "atlas")?.ready).toBe(true);
    expect(providers.find((p) => p.id === "fal")?.ready).toBe(false);
    expect(JSON.stringify(result)).not.toContain(ATLAS_KEY);
  });

  it("reports an unknown offering as a tool error", async () => {
    const result = await callTool(fullEnv(), "multix_model_catalog", {
      view: "show",
      offering: "fal:no/such-model",
    });
    expect(result.isError).toBe(true);
  });

  it("returns the same payload as the CLI query for the same request", () => {
    const query = {
      view: "compare" as const,
      task: "video",
      resolution: "720p",
      duration_s: 5,
      at: new Date("2026-10-28T00:00:00Z"),
    };
    expect(modelCatalogPayload({}, query)).toEqual(catalogQuery(query, () => false, []));
  });
});

describe("sort=released", () => {
  it("dates offerings from the public catalog listings and puts undated ones last", async () => {
    const { modelCatalogPayloadAsync } = await import("../src/jobs/model-catalog-view.js");
    const { resetReleaseDates } = await import("../src/jobs/release-dates.js");
    resetReleaseDates();
    const base = catalogQuery({ view: "models" }, () => false, []).offerings as Array<{
      provider: string;
      model: string;
    }>;
    const target = base.find((o) => o.provider === "fal");
    expect(target).toBeDefined();
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.fal.ai")) {
        return new Response(
          JSON.stringify({
            models: [{ endpoint_id: target?.model, metadata: { date: "2026-10-01T00:00:00Z" } }],
            has_more: false,
          }),
        );
      }
      throw new Error("offline");
    }) as typeof fetch;
    const payload = (await modelCatalogPayloadAsync(
      {},
      { view: "models", sort: "released" },
      fetchFn,
    )) as { offerings: Array<{ model: string; released_at?: string; released_source?: string }> };
    expect(payload.offerings[0]?.model).toBe(target?.model);
    expect(payload.offerings[0]?.released_at).toBe("2026-10-01T00:00:00.000Z");
    expect(payload.offerings[0]?.released_source).toBe("provider_listing");
    expect(payload.offerings.slice(1).every((o) => o.released_at === undefined)).toBe(true);
    resetReleaseDates();
  });
});
