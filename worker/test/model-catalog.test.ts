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
