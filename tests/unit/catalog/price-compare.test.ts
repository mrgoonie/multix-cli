/**
 * Price math and configuration-aware comparison. Every date is explicit so
 * the expected stale/current states do not depend on the clock.
 */

import { describe, expect, it } from "vitest";
import type { Task } from "../../../src/capabilities/capability-types.js";
import { buildOfferings } from "../../../src/catalog/catalog-build.js";
import type { Offering, QuoteRequest, RateView } from "../../../src/catalog/catalog-types.js";
import { compareOfferings, quoteRate } from "../../../src/catalog/price-compare.js";
import { RATE_CARDS, frameSize } from "../../../src/catalog/rate-cards.js";

const AT = new Date("2026-10-28T12:00:00Z");
const offerings = buildOfferings(AT);

const FAL_SEEDANCE = "fal:bytedance/seedance-2.5/text-to-video";
const ATLAS_SEEDANCE = "atlas:bytedance/seedance-2.5/text-to-video";
const FAL_KLING_PRO = "fal:fal-ai/kling-video/v3/pro/text-to-video";
const FAL_KLING_STANDARD = "fal:fal-ai/kling-video/v3/standard/text-to-video";
const FAL_KLING_4K = "fal:fal-ai/kling-video/v3/4k/text-to-video";

function rowOf(rows: { offering: string; rate_id?: string }[], offering: string, rateId?: string) {
  const row = rows.find(
    (r) => r.offering === offering && (rateId === undefined || r.rate_id === rateId),
  );
  if (!row) throw new Error(`no row for ${offering} ${rateId ?? ""}`);
  return row;
}

function syntheticRate(usd: number, over: Partial<RateView> = {}): RateView {
  return {
    id: `test/${usd}@api`,
    status: "current",
    tier: "api",
    currency: "USD",
    basis: "list",
    config: {},
    components: [{ meter: "output_video_seconds", usd, per: 1 }],
    units: [`USD ${usd} per output_video_seconds`],
    last_checked: "2026-10-28",
    source: "https://example.test/pricing",
    ...over,
  };
}

function syntheticOffering(id: string, rates: RateView[], tasks: Task[] = ["video"]): Offering {
  const sep = id.indexOf(":");
  return {
    id,
    provider: id.slice(0, sep),
    model: id.slice(sep + 1),
    tasks,
    verified_capability: false,
    rates,
    price_status: rates.some((r) => r.status === "current") ? "priced" : "stale",
  };
}

describe("rate cards", () => {
  it("states the fal Seedance 2.5 token price per 1000 video tokens for each resolution", () => {
    const fal = RATE_CARDS.filter((c) => c.id.startsWith("fal/seedance-2.5-t2v-"));
    expect(fal.map((c) => [c.config.resolution, c.windows[0]?.components[0]?.usd])).toEqual([
      ["480p", 0.0214],
      ["720p", 0.0214],
      ["1080p", 0.0234],
    ]);
    for (const card of fal) {
      // fal: generate_audio does not change the token count.
      expect(card.config.audio).toBeUndefined();
      expect(card.config_independent).toEqual(["audio"]);
      expect(card.token_fps).toBe(24);
      expect(card.windows[0]?.components[0]).toMatchObject({ meter: "video_tokens", per: 1000 });
      expect(card.source).toBe("https://fal.ai/models/bytedance/seedance-2.5/text-to-video");
    }
  });

  it("marks every Atlas Seedance row as an estimate, not a list price", () => {
    const atlas = RATE_CARDS.filter((c) => c.provider === "atlas");
    expect(atlas).toHaveLength(3);
    expect(atlas.every((c) => c.basis === "estimated")).toBe(true);
  });

  it("states Kling v3 per-second prices for audio off, audio on and voice control", () => {
    const pro = offerings.find((o) => o.id === FAL_KLING_PRO);
    expect(pro?.rates.map((r) => [r.config, r.components?.[0]?.usd])).toEqual([
      [{ audio: false }, 0.112],
      [{ audio: true }, 0.168],
      [{ audio: true, variant: "voice-control" }, 0.196],
    ]);
  });

  it("resolves frame sizes only for the named pairs it has on file", () => {
    expect(frameSize("720p", "16:9")).toEqual([1280, 720]);
    expect(frameSize("720p", "9:16")).toBeUndefined();
    expect(frameSize("8k", "16:9")).toBeUndefined();
  });
});

describe("price math", () => {
  it("prices fal Seedance 2.5 text-to-video 720p 16:9 for 10 s at 4.6224 USD", () => {
    const row = rowOf(
      compareOfferings(offerings, {
        task: "video",
        resolution: "720p",
        duration_s: 10,
        audio: true,
        at: AT,
      }).rows,
      FAL_SEEDANCE,
    );
    expect(row).toMatchObject({
      status: "priced",
      total_usd: 4.6224,
      basis: "list",
      units: { video_tokens: 216000 },
    });
    expect(row.assumptions).toEqual(["aspect ratio 16:9 (frame size of the token formula)"]);
  });

  it("computes the token count from frame size, duration and frame rate", () => {
    // 864 x 496 x 10 s x 24 fps / 1024 = 100440 tokens at 0.0214 per 1000.
    const card = offerings
      .find((o) => o.id === FAL_SEEDANCE)
      ?.rates.find((r) => r.config.resolution === "480p");
    const quote = quoteRate(
      offerings.find((o) => o.id === FAL_SEEDANCE) as Offering,
      card as RateView,
      { resolution: "480p", duration_s: 10, audio: true, at: AT },
    );
    expect(quote).toMatchObject({
      status: "priced",
      total_usd: 2.149416,
      units: { video_tokens: 100440 },
    });
  });

  it("prices fal Kling v3 pro text-to-video with audio off for 5 s at 0.56 USD", () => {
    const rows = compareOfferings(offerings, {
      task: "video",
      duration_s: 5,
      audio: false,
      at: AT,
    }).rows;
    expect(rowOf(rows, FAL_KLING_PRO)).toMatchObject({
      status: "priced",
      rate_id: "fal/kling-v3-pro-text-to-video-audio-off@api",
      total_usd: 0.56,
    });
  });

  it("prices fal Kling v3 standard text-to-video with audio off for 5 s at 0.42 USD", () => {
    const rows = compareOfferings(offerings, {
      task: "video",
      duration_s: 5,
      audio: false,
      at: AT,
    }).rows;
    expect(rowOf(rows, FAL_KLING_STANDARD)).toMatchObject({ status: "priced", total_usd: 0.42 });
  });

  it("prices Kling pro with audio on at the audio-on rate, not the audio-off one", () => {
    const rows = compareOfferings(offerings, {
      task: "video",
      duration_s: 5,
      audio: true,
      at: AT,
    }).rows;
    expect(rowOf(rows, FAL_KLING_PRO, "fal/kling-v3-pro-text-to-video-audio-on@api")).toMatchObject(
      {
        status: "priced",
        total_usd: 0.84,
      },
    );
  });

  it("prices Atlas Seedance per second as an estimate", () => {
    const row = rowOf(
      compareOfferings(offerings, { task: "video", resolution: "720p", duration_s: 10, at: AT })
        .rows,
      ATLAS_SEEDANCE,
    );
    expect(row).toMatchObject({
      status: "priced",
      basis: "estimated",
      total_usd: 3.00456,
      units: { output_video_seconds: 10 },
    });
  });

  it("does not guess a frame size for an aspect ratio the token formula lacks", () => {
    const row = rowOf(
      compareOfferings(offerings, {
        task: "video",
        resolution: "720p",
        duration_s: 10,
        audio: true,
        aspect_ratio: "9:16",
        at: AT,
      }).rows,
      FAL_SEEDANCE,
    );
    expect(row.status).toBe("unknown");
    expect(row.total_usd).toBeNull();
    expect(row.reasons).toEqual(["frame size of 720p at 9:16 is not on file"]);
  });

  it("asks for a duration instead of pricing per-second video without one", () => {
    const row = rowOf(
      compareOfferings(offerings, { task: "video", resolution: "720p", audio: true, at: AT }).rows,
      FAL_SEEDANCE,
    );
    expect(row).toMatchObject({
      status: "unknown",
      total_usd: null,
      reasons: ["pass a duration to price token-billed video"],
    });
  });
});

describe("compare: which configurations are ranked", () => {
  it("ranks only the configuration the card confirms and explains the rest", () => {
    const result = compareOfferings(offerings, {
      task: "video",
      resolution: "720p",
      duration_s: 10,
      audio: true,
      at: AT,
    });
    const fal = rowOf(result.rows, FAL_SEEDANCE);
    expect(fal).toMatchObject({ status: "priced", price_rank: 1, total_usd: 4.6224 });

    const atlas = rowOf(result.rows, ATLAS_SEEDANCE);
    expect(atlas).toMatchObject({
      status: "not_comparable",
      total_usd: null,
      reasons: ["source does not state the price for audio on"],
    });
    expect(atlas.price_rank).toBeUndefined();
  });

  it("reports a card that does not state a pinned setting as not comparable, with the reason", () => {
    const rows = compareOfferings(offerings, {
      task: "video",
      resolution: "720p",
      duration_s: 5,
      at: AT,
    }).rows;
    const kling = rowOf(rows, FAL_KLING_PRO);
    expect(kling).toMatchObject({
      status: "not_comparable",
      total_usd: null,
      reasons: ["source does not state the price for resolution 720p"],
    });
  });

  it("does not compare a different configuration", () => {
    const rows = compareOfferings(offerings, {
      task: "video",
      resolution: "4k",
      duration_s: 5,
      audio: true,
      at: AT,
    }).rows;
    const fal = rowOf(rows, FAL_SEEDANCE);
    expect(fal).toMatchObject({
      status: "not_comparable",
      total_usd: null,
      reasons: ["no price on file for resolution 4k, audio on"],
    });
    const kling4k = rowOf(rows, FAL_KLING_4K);
    expect(kling4k.status).toBe("priced");
    expect(kling4k.total_usd).toBe(2.1);
  });

  it("keeps a voice-control priced extra out of a plain comparison", () => {
    const rows = compareOfferings(offerings, {
      task: "video",
      duration_s: 5,
      audio: true,
      at: AT,
    }).rows;
    const voice = rows.filter((r) => r.rate_id?.endsWith("voice-control@api"));
    expect(voice).toEqual([]);
  });

  it("prices a row whose card fixes a setting the request left open but does not rank it", () => {
    const rows = compareOfferings(offerings, {
      task: "video",
      duration_s: 5,
      audio: false,
      at: AT,
    }).rows;
    const kling4k = rowOf(rows, FAL_KLING_4K);
    expect(kling4k).toMatchObject({
      status: "priced",
      total_usd: 2.1,
      open_settings: ["resolution 4k"],
    });
    expect(kling4k.price_rank).toBeUndefined();

    const standard = rowOf(rows, FAL_KLING_STANDARD);
    expect(standard.open_settings).toBeUndefined();
    expect(standard.price_rank).toBe(1);
  });

  it("ranks the fal Seedance row with audio unpinned, on or off, since audio does not change its price", () => {
    for (const audio of [undefined, true, false]) {
      const rows = compareOfferings(offerings, {
        task: "video",
        resolution: "720p",
        duration_s: 10,
        ...(audio === undefined ? {} : { audio }),
        at: AT,
      }).rows;
      const fal = rowOf(rows, FAL_SEEDANCE);
      expect(fal).toMatchObject({ status: "priced", total_usd: 4.6224 });
      expect(fal.price_rank).toBeGreaterThanOrEqual(1);
      expect(fal.open_settings).toBeUndefined();
    }
  });

  it("ranks cheaper quotes first and orders priced, then unknown, then not comparable", () => {
    const rows = compareOfferings(offerings, {
      task: "video",
      duration_s: 5,
      audio: false,
      at: AT,
    }).rows;
    const priced = rows.filter((r) => r.status === "priced" && r.price_rank !== undefined);
    const ranks = priced.map((r) => [r.total_usd, r.price_rank]);
    expect(ranks).toEqual([...ranks].sort((a, b) => (a[0] as number) - (b[0] as number)));
    expect(rows.findIndex((r) => r.status === "not_comparable")).toBeGreaterThan(
      rows.findLastIndex((r) => r.status === "priced"),
    );
  });

  it("gives tied prices the same rank", () => {
    const offs = [
      syntheticOffering("a:one", [syntheticRate(2)]),
      syntheticOffering("b:two", [syntheticRate(2)]),
      syntheticOffering("c:three", [syntheticRate(3)]),
    ];
    const rows = compareOfferings(offs, { task: "video", duration_s: 1 }).rows;
    expect(rows.map((r) => [r.offering, r.total_usd, r.price_rank])).toEqual([
      ["a:one", 2, 1],
      ["b:two", 2, 1],
      ["c:three", 3, 2],
    ]);
  });

  it("only compares offerings that have the requested task", () => {
    const offs = [
      syntheticOffering("a:speech", [syntheticRate(1)], ["speech"]),
      syntheticOffering("b:video", [syntheticRate(1)]),
    ];
    const rows = compareOfferings(offs, { task: "video", duration_s: 1 }).rows;
    expect(rows.map((r) => r.offering)).toEqual(["b:video"]);
  });

  it("records the time the comparison was made as an ISO string", () => {
    const result = compareOfferings(offerings, { task: "video", duration_s: 1, at: AT });
    expect(result.request.at).toBe(AT.toISOString());
    expect(result.note).toContain("price says nothing about output quality");
  });
});

describe("compare: unknown, stale and unverified prices are never zero", () => {
  it("keeps a stale price unknown with its check date, and never quotes it as 0", () => {
    const later = buildOfferings(new Date("2027-06-01T00:00:00Z"));
    const rows = compareOfferings(later, {
      task: "video",
      resolution: "720p",
      duration_s: 10,
      audio: true,
      at: new Date("2027-06-01T00:00:00Z"),
    }).rows;
    const fal = rowOf(rows, FAL_SEEDANCE);
    expect(fal.status).toBe("unknown");
    expect(fal.total_usd).toBeNull();
    expect(fal.price_rank).toBeUndefined();
    expect(fal.reasons?.[0]).toContain("last checked 2026-10-28, over 120 days ago");
  });

  it("uses the 120-day boundary inclusively", () => {
    const edge = buildOfferings(new Date("2027-02-25T00:00:00Z"));
    const past = buildOfferings(new Date("2027-02-25T00:00:01Z"));
    const quote = (o: Offering[]) =>
      rowOf(
        compareOfferings(o, { task: "video", resolution: "720p", duration_s: 10, audio: true })
          .rows,
        FAL_SEEDANCE,
      );
    expect(quote(edge)).toMatchObject({ status: "priced", total_usd: 4.6224 });
    expect(quote(past)).toMatchObject({ status: "unknown", total_usd: null });
  });

  it("reports an unverified price as unknown with its reason", () => {
    const offs = [
      syntheticOffering("x:model", [
        syntheticRate(1, { status: "unverified", detail: "Price x is not verified" }),
      ]),
    ];
    const rows = compareOfferings(offs, { task: "video", duration_s: 1 }).rows;
    expect(rows).toEqual([
      expect.objectContaining({
        status: "unknown",
        total_usd: null,
        reasons: ["Price x is not verified"],
      }),
    ]);
  });

  it("reports an offering with no price on file as unknown, not as free", () => {
    const offs = [syntheticOffering("x:model", [])];
    const rows = compareOfferings(offs, { task: "video", duration_s: 1 }).rows;
    expect(rows).toEqual([
      expect.objectContaining({
        status: "unknown",
        total_usd: null,
        reasons: ["no price on file"],
      }),
    ]);
  });

  it("never returns a zero total for an unpriced row, across every request shape", () => {
    const shapes: QuoteRequest[] = [];
    for (const task of [undefined, "video", "speech", "image-to-video"] as const) {
      for (const resolution of [undefined, "480p", "720p", "4k"]) {
        for (const audio of [undefined, true, false]) {
          for (const duration_s of [undefined, 5, 10]) {
            shapes.push({
              ...(task ? { task } : {}),
              ...(resolution ? { resolution } : {}),
              ...(audio !== undefined ? { audio } : {}),
              ...(duration_s ? { duration_s } : {}),
              at: AT,
            });
          }
        }
      }
    }
    for (const req of shapes) {
      for (const row of compareOfferings(offerings, req).rows) {
        if (row.status === "priced") expect(row.total_usd, JSON.stringify(req)).toBeGreaterThan(0);
        else expect(row.total_usd, `${row.offering} ${JSON.stringify(req)}`).toBeNull();
      }
    }
  });
});
