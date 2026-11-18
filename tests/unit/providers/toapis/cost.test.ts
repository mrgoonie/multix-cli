import { describe, expect, it } from "vitest";
import { estimateToapisCost, seedanceTokens } from "../../../../src/providers/toapis/cost.js";

const at = new Date("2026-11-18T00:00:00Z");

describe("ToAPIs cost estimate", () => {
  it("matches the live Seedance 480p 4 s token count", () => {
    expect(seedanceTokens("480p", 4)).toBe(40594);
    const e = estimateToapisCost({
      kind: "video",
      model: "seedance-2-5",
      options: { resolution: "480p", duration: 4 },
      at,
    });
    expect(e.status).toBe("estimated");
    expect(e.upper_bound).toBe("estimated");
    expect(e.high_usd).toBeCloseTo(0.40594, 5);
  });

  it("prices Seedance across 4-15 s at 720p when unset", () => {
    const e = estimateToapisCost({ kind: "video", model: "seedance-2-fast", options: {}, at });
    expect(e.units.video_tokens?.low).toBe(seedanceTokens("720p", 4));
    expect(e.units.video_tokens?.high).toBe(seedanceTokens("720p", 15));
  });

  it("gives a proven ceiling for per-image and per-second models", () => {
    const img = estimateToapisCost({
      kind: "image",
      model: "gpt-image-2",
      options: { resolution: "2k", count: 3 },
      at,
    });
    expect(img).toMatchObject({ upper_bound: "proven", high_usd: 0.06 });
    const vid = estimateToapisCost({
      kind: "video",
      model: "wan2.6",
      options: { resolution: "1080p", duration: 5 },
      at,
    });
    expect(vid).toMatchObject({ upper_bound: "proven", high_usd: 0.5 });
  });

  it("is unknown, never $0, for an unlisted model, missing duration or unpriced resolution", () => {
    expect(estimateToapisCost({ kind: "image", model: "nope", options: {}, at }).status).toBe(
      "unknown",
    );
    expect(
      estimateToapisCost({ kind: "video", model: "wan2.6", options: { resolution: "720p" }, at })
        .reason,
    ).toBe("missing_input");
    expect(
      estimateToapisCost({
        kind: "video",
        model: "seedance-2-fast",
        options: { resolution: "1080p", duration: 5 },
        at,
      }).reason,
    ).toBe("unsupported");
  });
});
