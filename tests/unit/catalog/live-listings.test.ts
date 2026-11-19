import { describe, expect, it } from "vitest";
import { readLiveListings } from "../../../src/catalog/live-listings.js";

type Route = (url: string, init?: RequestInit) => unknown;

/** fetch that answers by URL substring and records what it was asked. */
function fakeFetch(routes: Record<string, Route | number>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) return new Response("{}", { status: 404 });
    const [, r] = hit;
    if (typeof r === "number") return new Response("{}", { status: r });
    const body = r(url, init) as { __status?: number };
    return new Response(JSON.stringify(body), { status: body?.__status ?? 200 });
  }) as typeof fetch;
  return { fn, calls };
}

const openrouter = () => ({
  data: [
    {
      id: "acme/img-1",
      name: "Acme Image",
      architecture: { input_modalities: ["text", "image"] },
      pricing: { prompt: "0.000001", completion: "0", image_output: "0.00004", mystery: "0.5" },
      created: 1767225600,
    },
  ],
});
const falList = (url: string) =>
  url.includes("text-to-image")
    ? {
        models: [
          { endpoint_id: "fal-ai/acme", metadata: { display_name: "Acme", date: "2026-01-02" } },
        ],
        has_more: false,
      }
    : { models: [], has_more: false };
const atlas = () => ({
  data: [
    {
      model: "acme/video",
      type: "Video",
      displayName: "Acme Video",
      categories: ["TEXT-TO-VIDEO", "IMAGE-TO-VIDEO"],
      price: { actual: { base_price: "0.134" } },
    },
    {
      model: "acme/music",
      type: "Audio",
      categories: ["TEXT-TO-AUDIO"],
      price: { actual: { base_price: "0.15", unit: "generation" } },
    },
    {
      model: "acme/free",
      type: "Image",
      categories: ["TEXT-TO-IMAGE"],
      price: { actual: { base_price: "0" } },
    },
    {
      model: "acme/llm",
      type: "Text",
      categories: ["TEXT"],
      price: { actual: { base_price: "1" } },
    },
  ],
});

describe("readLiveListings", () => {
  it("maps provider listing prices with their stated units and drops zero or text rows", async () => {
    const { fn } = fakeFetch({
      "openrouter.ai": openrouter,
      "api.fal.ai/v1/models?": falList,
      "atlascloud.ai": atlas,
    });
    const snap = await readLiveListings(fn, { now: new Date("2026-11-19T00:00:00Z") });

    const or = snap.listings.find((l) => l.provider === "openrouter" && l.task === "image");
    expect(or?.prices).toEqual([
      { label: "prompt", usd: 0.000001, unit: "input token" },
      { label: "image_output", usd: 0.00004, unit: "output image token" },
      { label: "mystery", usd: 0.5, unit: null },
    ]);
    expect(or?.released_at).toBe("2026-01-01T00:00:00.000Z");

    const video = snap.listings.filter((l) => l.model === "acme/video");
    expect(video.map((l) => l.task).sort()).toEqual(["image-to-video", "video"]);
    expect(video[0]?.prices).toEqual([{ label: "base_price", usd: 0.134, unit: null }]);
    expect(snap.listings.find((l) => l.model === "acme/music")?.prices[0]?.unit).toBe("generation");
    expect(snap.listings.find((l) => l.model === "acme/free")?.prices).toEqual([]);
    expect(snap.listings.some((l) => l.model === "acme/llm")).toBe(false);
    expect(snap.listings.every((l) => l.prices.every((p) => p.usd > 0))).toBe(true);

    const fal = snap.listings.find((l) => l.provider === "fal");
    expect(fal).toMatchObject({ model: "fal-ai/acme", task: "image", prices: [] });
    expect(snap.sources.find((s) => s.provider === "fal" && s.state === "skipped")?.detail).toBe(
      "no pricing key configured",
    );
  });

  it("reads fal prices with the key and never puts the key in the snapshot", async () => {
    const { fn, calls } = fakeFetch({
      "api.fal.ai/v1/models/pricing": () => ({
        prices: [
          { endpoint_id: "fal-ai/acme", unit_price: 0.003, unit: "megapixels", currency: "USD" },
        ],
      }),
      "api.fal.ai/v1/models?": falList,
      "openrouter.ai": openrouter,
      "atlascloud.ai": atlas,
    });
    const snap = await readLiveListings(fn, { falKey: "secret-key" });
    expect(snap.listings.find((l) => l.model === "fal-ai/acme")?.prices).toEqual([
      { label: "unit_price", usd: 0.003, unit: "megapixels" },
    ]);
    const priced = calls.find((c) => c.url.includes("/pricing"));
    expect(new Headers(priced?.init?.headers).get("authorization")).toBe("Key secret-key");
    expect(JSON.stringify(snap)).not.toContain("secret-key");
  });

  it("isolates fal ids without a price when fal answers 404 for their batch", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `fal-ai/m${i}`);
    const list = () => ({
      models: ids.map((id) => ({ endpoint_id: id, metadata: {} })),
      has_more: false,
    });
    const { fn } = fakeFetch({
      "api.fal.ai/v1/models/pricing": (url) => {
        const asked = new URL(url).searchParams.getAll("endpoint_id");
        if (asked.includes("fal-ai/m3")) return { __status: 404 };
        return {
          prices: asked.map((id) => ({
            endpoint_id: id,
            unit_price: 0.01,
            unit: "image",
            currency: "USD",
          })),
        };
      },
      "api.fal.ai/v1/models?": list,
      "openrouter.ai": openrouter,
      "atlascloud.ai": atlas,
    });
    const snap = await readLiveListings(fn, { falKey: "k" });
    const priced = new Set(
      snap.listings.filter((l) => l.provider === "fal" && l.prices.length).map((l) => l.model),
    );
    expect([...priced].sort()).toEqual(["fal-ai/m0", "fal-ai/m1", "fal-ai/m2", "fal-ai/m4"]);
    expect(snap.sources.find((s) => s.url.endsWith("/pricing"))?.state).toBe("fresh");
  });

  it("asks fal only for prices missing or older than a week, and stops on 429", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `fal-ai/m${i}`);
    const asked: string[][] = [];
    let calls = 0;
    const { fn } = fakeFetch({
      "api.fal.ai/v1/models/pricing": (url) => {
        const batch = new URL(url).searchParams.getAll("endpoint_id");
        asked.push(batch);
        if (++calls > 1) return { __status: 429 };
        return {
          prices: batch.map((id) => ({
            endpoint_id: id,
            unit_price: 0.01,
            unit: "image",
            currency: "USD",
          })),
        };
      },
      "api.fal.ai/v1/models?": () => ({
        models: ids.map((id) => ({ endpoint_id: id, metadata: {} })),
        has_more: false,
      }),
      "openrouter.ai": openrouter,
      "atlascloud.ai": atlas,
    });
    const now = new Date("2026-11-19T00:00:00Z");
    const fresh = {
      price: { label: "unit_price", usd: 0.5, unit: "video" },
      checked_at: "2026-11-18T00:00:00.000Z",
    };
    const old = {
      price: { label: "unit_price", usd: 0.9, unit: "video" },
      checked_at: "2026-11-01T00:00:00.000Z",
    };
    const known = Object.fromEntries(ids.slice(0, 55).map((id, i) => [id, i === 0 ? old : fresh]));
    const snap = await readLiveListings(fn, { falKey: "k", falPrices: known, now });
    // Only the 5 missing ids and the 1 old one are asked, missing first.
    expect(asked[0]?.sort()).toEqual(["fal-ai/m0", ...ids.slice(55)].sort());
    expect(snap.fal_prices?.["fal-ai/m1"]).toEqual(fresh);
    expect(snap.fal_prices?.["fal-ai/m0"]?.price?.usd).toBe(0.01);
    expect(snap.listings.find((l) => l.model === "fal-ai/m2")?.prices[0]?.usd).toBe(0.5);
    expect(snap.sources.find((s) => s.url.endsWith("/pricing"))).toMatchObject({
      state: "fresh",
      count: 60,
    });
  });

  it("marks a failing provider unavailable without failing the snapshot", async () => {
    const { fn } = fakeFetch({ "openrouter.ai": 500, "api.fal.ai": 503, "atlascloud.ai": atlas });
    const snap = await readLiveListings(fn);
    expect(
      snap.sources
        .filter((s) => s.provider === "openrouter")
        .every((s) => s.state === "unavailable"),
    ).toBe(true);
    expect(snap.sources.find((s) => s.provider === "atlas")?.state).toBe("fresh");
    expect(snap.listings.length).toBeGreaterThan(0);
  });
});
