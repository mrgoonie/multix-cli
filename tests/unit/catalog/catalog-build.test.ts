/**
 * The catalogue as a reader sees it: offerings built from capabilities, price
 * states at a given instant, filtering, sorting and lookup by reference.
 */

import { describe, expect, it } from "vitest";
import type { PriceEntry } from "../../../src/budget/pricing-catalog.js";
import {
  buildOfferings,
  buildProviders,
  filterOfferings,
  findOfferings,
  rateView,
  sortOfferings,
} from "../../../src/catalog/catalog-build.js";

const AT = new Date("2026-10-28T12:00:00Z");
const offerings = buildOfferings(AT);
const byId = (id: string) => {
  const o = offerings.find((x) => x.id === id);
  if (!o) throw new Error(`no offering ${id}`);
  return o;
};

const testEntry = (over: Partial<PriceEntry> = {}): PriceEntry =>
  ({
    id: "test/entry@api",
    provider: "test",
    models: ["model-a"],
    tier: "api",
    currency: "USD",
    region: "global",
    windows: [{ components: [{ meter: "output_video_seconds", usd: 1, per: 1 }] }],
    last_checked: "2026-10-28",
    source: "https://example.test/pricing",
    verified: true,
    ...over,
  }) as PriceEntry;

describe("offerings", () => {
  it("lists each offering once, sorted by id", () => {
    const ids = offerings.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it("gives every offering at least one task", () => {
    expect(offerings.every((o) => o.tasks.length > 0)).toBe(true);
  });

  it("describes fal Seedance 2.5 as a priced, unverified video offering with its family and command", () => {
    expect(byId("fal:bytedance/seedance-2.5/text-to-video")).toMatchObject({
      provider: "fal",
      model: "bytedance/seedance-2.5/text-to-video",
      family: "seedance-2.5",
      tasks: ["video"],
      command: "fal video",
      verified_capability: false,
      price_status: "priced",
    });
  });

  it("marks an offering with a verified capability but no price as no_price, with no rates", () => {
    const o = byId("fal:elevenlabs/tts/eleven-v4");
    expect(o).toMatchObject({ verified_capability: true, price_status: "no_price", rates: [] });
  });

  it("reports the price state at the requested instant, not at build time", () => {
    const later = buildOfferings(new Date("2027-06-01T00:00:00Z"));
    expect(
      later.find((o) => o.id === "fal:bytedance/seedance-2.5/text-to-video")?.price_status,
    ).toBe("stale");
  });
});

describe("rateView", () => {
  it("shows a current price with its unit text, components and source", () => {
    const view = rateView(testEntry(), "model-a", AT);
    expect(view).toMatchObject({
      id: "test/entry@api",
      status: "current",
      basis: "list",
      config: {},
      units: ["USD 1 per output_video_seconds"],
      components: [{ meter: "output_video_seconds", usd: 1, per: 1 }],
      last_checked: "2026-10-28",
      source: "https://example.test/pricing",
    });
  });

  it("shows the per-N unit when the price is per more than one unit", () => {
    const view = rateView(
      testEntry({ windows: [{ components: [{ meter: "video_tokens", usd: 0.0214, per: 1000 }] }] }),
      "model-a",
      AT,
    );
    expect(view.units).toEqual(["USD 0.0214 per 1000 video_tokens"]);
  });

  it("marks an unverified price as unverified, with no components", () => {
    const view = rateView(testEntry({ verified: false }), "model-a", AT);
    expect(view).toMatchObject({ status: "unverified", units: [] });
    expect(view.components).toBeUndefined();
    expect(view.detail).toContain("not verified");
  });

  it("marks a price checked more than 120 days before the instant as stale", () => {
    const view = rateView(testEntry(), "model-a", new Date("2027-06-01T00:00:00Z"));
    expect(view.status).toBe("stale");
    expect(view.detail).toContain("over 120 days ago");
  });

  it("marks a price with no window covering the instant as no_window", () => {
    const entry = testEntry({
      windows: [
        {
          from: "2027-01-01T00:00:00Z",
          components: [{ meter: "output_video_seconds", usd: 1, per: 1 }],
        },
      ],
    });
    expect(rateView(entry, "model-a", AT).status).toBe("no_window");
  });

  it("refuses a price that ends within a day with no known successor", () => {
    const entry = testEntry({
      windows: [
        {
          until: "2026-10-28T20:00:00Z",
          components: [{ meter: "output_video_seconds", usd: 1, per: 1 }],
        },
      ],
    });
    const view = rateView(entry, "model-a", AT);
    expect(view.status).toBe("no_window");
    expect(view.detail).toContain("the next price is not known");
  });

  it("marks a price for a model the entry does not list as no_price", () => {
    expect(rateView(testEntry(), "other-model", AT).status).toBe("no_price");
  });
});

describe("filterOfferings", () => {
  it("filters by task, provider and family", () => {
    const rows = filterOfferings(offerings, {
      task: "image-to-video",
      provider: "fal",
      family: "kling-v3-pro",
    });
    expect(rows.map((o) => o.id)).toEqual(["fal:fal-ai/kling-video/v3/pro/image-to-video"]);
  });

  it("matches text case-insensitively in the id, name or family", () => {
    const rows = filterOfferings(offerings, { query: "KLING-V3-4K" });
    expect(rows.map((o) => o.id)).toEqual([
      "fal:fal-ai/kling-video/v3/4k/image-to-video",
      "fal:fal-ai/kling-video/v3/4k/text-to-video",
    ]);
  });

  it("keeps only priced offerings when asked", () => {
    const rows = filterOfferings(offerings, { priced: true });
    expect(rows.length).toBeLessThan(offerings.length);
    expect(rows.every((o) => o.price_status === "priced")).toBe(true);
  });

  it("keeps only providers the caller has keys for", () => {
    const rows = filterOfferings(offerings, { ready: (p) => p === "fal" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((o) => o.provider === "fal")).toBe(true);
  });

  it("matches a resolution on any rate card of the offering", () => {
    const ids = filterOfferings(offerings, { resolution: "4k" }).map((o) => o.id);
    expect(ids).toEqual([
      "fal:fal-ai/kling-video/v3/4k/image-to-video",
      "fal:fal-ai/kling-video/v3/4k/text-to-video",
    ]);
  });

  it("matches an audio setting, and an offering whose price is independent of audio matches either", () => {
    const off = filterOfferings(offerings, { audio: false, task: "video" }).map((o) => o.id);
    expect(off).toContain("fal:fal-ai/kling-video/v3/4k/text-to-video");
    expect(off).toContain("fal:fal-ai/kling-video/v3/pro/text-to-video");
    expect(off).not.toContain("fal:bytedance/seedance-2.5/text-to-video");
  });
});

describe("sortOfferings", () => {
  it("sorts by id by default and by provider when asked", () => {
    const rows = sortOfferings(offerings, "provider");
    const providers = rows.map((o) => o.provider);
    expect(providers).toEqual([...providers].sort((a, b) => a.localeCompare(b)));
    expect(sortOfferings(offerings, "id").map((o) => o.id)).toEqual(offerings.map((o) => o.id));
  });

  it("sorts by price within a billing unit, so per-second and per-token prices are never mixed", () => {
    const video = sortOfferings(filterOfferings(offerings, { task: "video" }), "price").map(
      (o) => o.id,
    );
    const firstTokenRow = video.indexOf("fal:bytedance/seedance-2.5/text-to-video");
    const firstSecondRow = video.indexOf("atlas:bytedance/seedance-2.5/text-to-video");
    // output_video_seconds sorts before video_tokens, so every per-second offering comes first.
    expect(firstSecondRow).toBeLessThan(firstTokenRow);
    expect(video[0]).toBe("fal:fal-ai/kling-video/v3/standard/text-to-video");
    expect(video.indexOf("fal:fal-ai/kling-video/v3/pro/text-to-video")).toBeLessThan(
      video.indexOf("fal:fal-ai/kling-video/v3/4k/text-to-video"),
    );
  });

  it("puts offerings without a current price last when sorting by price", () => {
    const speech = sortOfferings(filterOfferings(offerings, { task: "speech" }), "price");
    const lastPriced = speech.findLastIndex((o) => o.price_status === "priced");
    const firstUnpriced = speech.findIndex((o) => o.price_status !== "priced");
    expect(firstUnpriced).toBeGreaterThan(lastPriced);
    expect(speech.some((o) => o.id === "fal:elevenlabs/tts/eleven-v4")).toBe(true);
  });

  it("sorts by the latest check date first, then by id", () => {
    const rows = sortOfferings(offerings, "checked");
    const latest = (o: { rates: { last_checked: string }[] }) =>
      o.rates
        .map((r) => r.last_checked)
        .sort()
        .at(-1) ?? "";
    const dates = rows.map(latest);
    expect(dates).toEqual([...dates].sort().reverse());
  });
});

describe("findOfferings", () => {
  it("finds an exact <provider>:<model> id", () => {
    expect(
      findOfferings(offerings, "fal:fal-ai/kling-video/v3/pro/text-to-video").map((o) => o.id),
    ).toEqual(["fal:fal-ai/kling-video/v3/pro/text-to-video"]);
  });

  it("returns every provider that offers a bare model id, so the caller can ask which one", () => {
    expect(
      findOfferings(offerings, "bytedance/seedance-2.5/text-to-video").map((o) => o.id),
    ).toEqual([
      "atlas:bytedance/seedance-2.5/text-to-video",
      "fal:bytedance/seedance-2.5/text-to-video",
    ]);
  });

  it("returns nothing for an unknown reference", () => {
    expect(findOfferings(offerings, "nope:nothing")).toEqual([]);
  });
});

describe("buildProviders", () => {
  it("lists the named groups even without offerings, with counts and readiness", () => {
    const providers = buildProviders(offerings, ["minimax", "fal"], (p) => p === "fal");
    const minimax = providers.find((p) => p.id === "minimax");
    expect(minimax).toMatchObject({
      name: "MiniMax",
      ready: false,
      offerings: 0,
      priced_offerings: 0,
    });
    const fal = providers.find((p) => p.id === "fal");
    expect(fal).toMatchObject({ ready: true, pricing_url: "https://fal.ai/pricing" });
    expect(fal?.priced_offerings).toBeLessThan(fal?.offerings ?? 0);
  });

  it("never reports key values, only readiness", () => {
    const providers = buildProviders(offerings, ["fal"], () => true);
    expect(JSON.stringify(providers)).not.toMatch(/key|secret|token/i);
  });
});
