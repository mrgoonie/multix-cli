import { describe, expect, it } from "vitest";
import { checkBudget } from "../../../../src/budget/command-cost.js";
import { requireCatalogModel } from "../../../../src/providers/sume/catalog.js";
import { estimateFromCatalog, estimateFromQuote } from "../../../../src/providers/sume/pricing.js";
import { buildImageBody, buildVideoBody } from "../../../../src/providers/sume/request.js";
import { CATALOG_MODELS } from "./fake-sume.js";

const model = (id: string, router: "image" | "video") =>
  requireCatalogModel(CATALOG_MODELS, id, router);

const video = (id: string, input: Partial<Parameters<typeof buildVideoBody>[1]>) =>
  buildVideoBody(model(id, "video"), { refImages: [], refVideos: [], refAudios: [], ...input });

describe("catalog model lookup", () => {
  it("matches ids exactly and never guesses", () => {
    expect(() => requireCatalogModel(CATALOG_MODELS, "Seedream-V4", "image")).toThrow(
      /not in the catalog/,
    );
  });

  it("points a model at the router that serves it", () => {
    expect(() => requireCatalogModel(CATALOG_MODELS, "kling-3", "image")).toThrow(
      /multix sume video -m kling-3/,
    );
    expect(requireCatalogModel(CATALOG_MODELS, "infinitalk", "video").id).toBe("infinitalk");
  });

  it("refuses models served by their own route", () => {
    expect(() => requireCatalogModel(CATALOG_MODELS, "sume-remix-restyle", "video")).toThrow(
      /own route/,
    );
  });
});

describe("request bodies", () => {
  it("builds a text-to-image body from listed options", () => {
    const body = buildImageBody(model("seedream-v4", "image"), {
      prompt: "a fox",
      images: [],
      aspectRatio: "16:9",
      numImages: 2,
      outputFormat: "webp",
    });
    expect(body).toEqual({
      model: "seedream-v4",
      prompt: "a fox",
      aspect_ratio: "16:9",
      num_images: 2,
      output_format: "webp",
    });
  });

  it("refuses options the catalog does not list", () => {
    const m = model("seedream-v4", "image");
    expect(() => buildImageBody(m, { prompt: "x", images: [], aspectRatio: "21:9" })).toThrow(
      /must be one of/,
    );
    expect(() => buildImageBody(m, { prompt: "x", images: [], resolution: "4K" })).toThrow(
      /does not take --resolution/,
    );
    expect(() => buildImageBody(m, { prompt: "x", images: [], numImages: 5 })).toThrow();
  });

  it("gates media by capability", () => {
    expect(() => video("kling-3", { prompt: "x", refImages: ["https://a/b.png"] })).toThrow(
      /does not take --ref-image/,
    );
    const i2v = video("kling-3", {
      prompt: "x",
      image: "https://cdn.example.com/a.png",
      endImage: "https://cdn.example.com/b.png",
      duration: 5,
    });
    expect(i2v).toMatchObject({ image_url: expect.any(String), end_image_url: expect.any(String) });
  });

  it("enforces required catalog request fields and duration ranges", () => {
    expect(() =>
      video("infinitalk", { image: "https://a/face.png", audio: "https://a/s.mp3", duration: 5 }),
    ).toThrow(/requires/);
    expect(() =>
      video("infinitalk", {
        prompt: "studio",
        image: "https://a/face.png",
        audio: "https://a/s.mp3",
        duration: 40,
      }),
    ).toThrow();
    expect(() => video("kling-3", { prompt: "x", duration: 3 })).toThrow();
  });

  it("refuses a model whose required field multix cannot send (schema mismatch)", () => {
    expect(() =>
      video("veed-dubbing", { prompt: "x", video: "https://cdn.example.com/a.mp4" }),
    ).toThrow(/schema mismatch/);
  });
});

describe("pricing", () => {
  const at = new Date("2026-10-28T00:00:00Z");

  it("prices a quote as a proven cap rounded up to the cent", () => {
    const e = estimateFromQuote("kling-3", { usd_micros: 560_001 }, { source: "s", at });
    expect(e.status).toBe("estimated");
    expect(e.expected_usd).toBe(0.560001);
    expect(e.high_usd).toBe(0.57);
    expect(e.upper_bound).toBe("proven");
    expect(e.rate?.source).toBe("s");
    expect(() => checkBudget(e, 1, "strict")).not.toThrow();
  });

  it("prices the catalog per second over the requested duration, never a proven cap", () => {
    const body = video("kling-3", { prompt: "x", duration: 5, generateAudio: true });
    const e = estimateFromCatalog(model("kling-3", "video"), body, {
      source: "https://api.sume.com/v1/open/catalog",
      fetchedAt: "2026-10-27T00:00:00.000Z",
      at,
    });
    expect(e.high_usd).toBeCloseTo(0.84, 6);
    expect(e.upper_bound).toBe("estimated");
    expect(e.rate?.last_checked).toBe("2026-10-27T00:00:00.000Z");
    expect(() => checkBudget(e, 10, "strict")).toThrow(/not a proven cap/);
  });

  it("prices an open duration over the model's whole range", () => {
    const body = video("kling-3", { prompt: "x" });
    const e = estimateFromCatalog(model("kling-3", "video"), body, {
      source: "s",
      fetchedAt: "2026-10-27T00:00:00.000Z",
      at,
    });
    expect(e.low_usd).toBeCloseTo(0.112 * 4, 6);
    expect(e.high_usd).toBeCloseTo(0.168 * 15, 6);
  });

  it("returns unknown, not $0, when the catalog has no matching price", () => {
    const body = { model: "sume-remix-restyle" };
    const remix = CATALOG_MODELS.find((m) => m.id === "sume-remix-restyle");
    if (!remix) throw new Error("fixture");
    const e = estimateFromCatalog(remix, body, { source: "s", fetchedAt: "x", at });
    expect(e.status).toBe("unknown");
    expect(e.high_usd).toBeNull();
  });
});
