/**
 * Recommendations: exclusion of "avoid" notes, the sample thresholds for
 * reliability and ratings, the score and its coverage, and the sort order.
 */

import { describe, expect, it } from "vitest";
import { buildOfferings } from "../../../src/catalog/catalog-build.js";
import type { Review, UseCaseNote } from "../../../src/catalog/catalog-types.js";
import {
  MIN_OPERATIONS,
  MIN_RATINGS,
  type RecommendInput,
  recommend,
} from "../../../src/catalog/recommend.js";
import type { UsageRow } from "../../../src/catalog/usage-aggregate.js";

const AT = new Date("2026-10-28T12:00:00Z");
const offerings = buildOfferings(AT);
const SEEDANCE_FAL = "fal:bytedance/seedance-2.5/text-to-video";
const SEEDANCE_ATLAS = "atlas:bytedance/seedance-2.5/text-to-video";
const KLING_PRO = "fal:fal-ai/kling-video/v3/pro/text-to-video";
const KLING_STANDARD = "fal:fal-ai/kling-video/v3/standard/text-to-video";
const ALL_READY = () => true;
const FAL_ONLY = (p: string) => p === "fal";

/** Seedance 720p 16:9 with audio on for 10 s: only the fal card confirms that configuration. */
const SEEDANCE_REQUEST = {
  task: "video",
  resolution: "720p",
  duration_s: 10,
  audio: true,
  aspect_ratio: "16:9",
  at: AT,
} as const;

/** A usage row; `requests` (runs, polls included) defaults to one per operation. */
function usage(
  key: string,
  operations: number,
  completed: number,
  requests = operations,
): UsageRow {
  return {
    key,
    requests,
    operations,
    completed,
    failed: operations - completed,
    canceled: 0,
    success_rate: operations ? completed / operations : null,
    retries: 0,
    p50_s: null,
    p95_s: null,
    outputs: 0,
    cost: {
      known_usd: 0,
      provider_reported_usd: 0,
      computed_usd: 0,
      estimated_usd: null,
      unknown_operations: 0,
      uncertain_operations: 0,
      per_success_usd: null,
    },
    first_at: "2026-10-27T10:00:00.000Z",
    last_at: "2026-10-27T10:00:00.000Z",
    sample: { n: operations, confidence: "low" },
  };
}

function rating(offering: string, score: number, use_case?: string): Review {
  return {
    id: `r_${offering}_${score}_${use_case ?? ""}`,
    offering,
    scope: "private",
    score,
    ...(use_case ? { use_case } : {}),
    created_at: "2026-10-27T10:00:00.000Z",
    updated_at: "2026-10-27T10:00:00.000Z",
  };
}

function note(offering: string, use_case: string, verdict: UseCaseNote["verdict"]): UseCaseNote {
  return {
    id: `n_${offering}_${use_case}_${verdict}`,
    offering,
    use_case,
    verdict,
    scope: "private",
    created_at: "2026-10-27T10:00:00.000Z",
    updated_at: "2026-10-27T10:00:00.000Z",
  };
}

function input(over: Partial<RecommendInput> = {}): RecommendInput {
  return {
    offerings,
    request: { ...SEEDANCE_REQUEST },
    usage: [],
    reviews: [],
    notes: [],
    ready: ALL_READY,
    ...over,
  };
}

function find(result: ReturnType<typeof recommend>, offering: string) {
  const row = result.recommendations.find((r) => r.offering === offering);
  if (!row) throw new Error(`${offering} not recommended`);
  return row;
}

describe("exclusion by note", () => {
  it("leaves out an offering noted avoid for the use case, and says why", () => {
    const result = recommend(
      input({ use_case: "product-ugc", notes: [note(SEEDANCE_FAL, "product-ugc", "avoid")] }),
    );
    expect(result.recommendations.map((r) => r.offering)).not.toContain(SEEDANCE_FAL);
    expect(result.excluded).toEqual([
      { offering: SEEDANCE_FAL, reason: 'noted "avoid" for product-ugc' },
    ]);
  });

  it("keeps an offering noted avoid for a different use case", () => {
    const result = recommend(
      input({ use_case: "product-ugc", notes: [note(SEEDANCE_FAL, "music-video", "avoid")] }),
    );
    expect(result.recommendations.map((r) => r.offering)).toContain(SEEDANCE_FAL);
    expect(result.excluded).toEqual([]);
  });

  it("keeps an offering with a recommended or mixed note for the use case", () => {
    const result = recommend(
      input({ use_case: "product-ugc", notes: [note(SEEDANCE_FAL, "product-ugc", "mixed")] }),
    );
    expect(result.recommendations.map((r) => r.offering)).toContain(SEEDANCE_FAL);
  });
});

describe("sample thresholds", () => {
  it("leaves reliability out below five operations and says how many are needed", () => {
    const result = recommend(
      input({ usage: [usage(SEEDANCE_FAL, MIN_OPERATIONS - 1, MIN_OPERATIONS - 1)] }),
    );
    const row = find(result, SEEDANCE_FAL);
    expect(row.factors.reliability).toBeUndefined();
    expect(row.reasons).toContain(
      `reliability: ${MIN_OPERATIONS - 1} operations (needs ${MIN_OPERATIONS})`,
    );
  });

  it("does not let status polls reach the minimum: two jobs with many runs are two operations", () => {
    const result = recommend(input({ usage: [usage(SEEDANCE_FAL, 2, 2, 8)] }));
    const row = find(result, SEEDANCE_FAL);
    expect(row.factors.reliability).toBeUndefined();
    expect(row.reasons).toContain(`reliability: 2 operations (needs ${MIN_OPERATIONS})`);
  });

  it("counts reliability from five operations, with the completed operations as evidence", () => {
    const result = recommend(input({ usage: [usage(SEEDANCE_FAL, 5, 4, 12)] }));
    expect(find(result, SEEDANCE_FAL).factors.reliability).toEqual({
      value: 0.8,
      weight: 0.35,
      evidence: "4/5 operations completed through multix",
    });
  });

  it("leaves the rating out below three ratings", () => {
    const result = recommend(
      input({ reviews: [rating(SEEDANCE_FAL, 5), rating(SEEDANCE_FAL, 4)] }),
    );
    const row = find(result, SEEDANCE_FAL);
    expect(row.factors.rating).toBeUndefined();
    expect(row.reasons).toContain(`rating: 2 ratings (needs ${MIN_RATINGS})`);
  });

  it("averages ratings from three on, scaled from 1–5 to 0–1", () => {
    const result = recommend(
      input({
        reviews: [rating(SEEDANCE_FAL, 4), rating(SEEDANCE_FAL, 4), rating(SEEDANCE_FAL, 5)],
      }),
    );
    const factor = find(result, SEEDANCE_FAL).factors.rating;
    expect(factor?.weight).toBe(0.25);
    expect(factor?.value).toBeCloseTo((4.33 - 1) / 4, 6);
    expect(factor?.evidence).toBe("average 4.33/5 from 3 ratings (0 tied to a run)");
  });

  it("only counts ratings for the use case asked about", () => {
    const reviews = [
      rating(SEEDANCE_FAL, 5, "product-ugc"),
      rating(SEEDANCE_FAL, 5, "product-ugc"),
      rating(SEEDANCE_FAL, 5, "music-video"),
    ];
    const result = recommend(input({ use_case: "product-ugc", reviews }));
    expect(find(result, SEEDANCE_FAL).factors.rating).toBeUndefined();
  });
});

describe("factors, coverage and score", () => {
  it("weights a note by its verdict: recommended counts fully, mixed half", () => {
    const rec = find(
      recommend(input({ notes: [note(SEEDANCE_FAL, "product-ugc", "recommended")] })),
      SEEDANCE_FAL,
    );
    expect(rec.factors.note).toEqual({
      value: 1,
      weight: 0.2,
      evidence: "recommended for product-ugc",
    });
    const mixed = find(
      recommend(input({ notes: [note(SEEDANCE_FAL, "product-ugc", "mixed")] })),
      SEEDANCE_FAL,
    );
    expect(mixed.factors.note?.value).toBe(0.5);
  });

  it("scores an avoid note below a mixed one when no use case narrows the notes", () => {
    const avoid = find(
      recommend(input({ notes: [note(SEEDANCE_FAL, "music-video", "avoid")] })),
      SEEDANCE_FAL,
    );
    const mixed = find(
      recommend(input({ notes: [note(SEEDANCE_FAL, "music-video", "mixed")] })),
      SEEDANCE_FAL,
    );
    expect(avoid.factors.note?.value).toBeLessThan(mixed.factors.note?.value ?? 0);
  });

  it("scores a price the cheapest comparable quote as 1 and the dearest as 0", () => {
    const result = recommend(
      input({ request: { task: "video", duration_s: 5, audio: false, at: AT } }),
    );
    const standard = find(result, KLING_STANDARD);
    const pro = find(result, KLING_PRO);
    expect(standard.quote_usd).toBe(0.42);
    expect(standard.factors.price).toEqual({
      value: 1,
      weight: 0.2,
      evidence: "quoted $0.42 for this request (range $0.42–$0.56)",
    });
    expect(pro.quote_usd).toBe(0.56);
    expect(pro.factors.price?.value).toBe(0);
  });

  it("gives the price factor full value when only one offering has a comparable quote", () => {
    const rec = find(recommend(input()), SEEDANCE_FAL);
    expect(rec.factors.price?.value).toBe(1);
    expect(rec.quote_usd).toBe(4.6224);
  });

  it("gives no price factor to an estimate or a quote with an assumption, and says why", () => {
    // Seedance 720p for 5 s without audio or aspect ratio: Atlas is a lower estimate, fal assumes 16:9.
    const result = recommend(
      input({ request: { task: "video", resolution: "720p", duration_s: 5, at: AT } }),
    );
    const atlas = find(result, SEEDANCE_ATLAS);
    expect(atlas.factors.price).toBeUndefined();
    expect(atlas.quote_usd).toBeNull();
    expect(atlas.reasons).toContain(
      "price: quote not ranked: the provider shows this price as an estimate and bills the final amount from the usage it measures",
    );
    expect(atlas.unranked_quote).toEqual({ usd: 1.50228, reasons: expect.any(Array) });
    const fal = find(result, SEEDANCE_FAL);
    expect(fal.factors.price).toBeUndefined();
    expect(fal.quote_usd).toBeNull();
    expect(fal.reasons.join(" ")).toContain("the quote assumes aspect ratio 16:9");
  });

  it("gives the price factor to the confirmed list price and not to the cheaper estimate", () => {
    const result = recommend(
      input({
        request: { task: "video", resolution: "720p", duration_s: 5, aspect_ratio: "16:9", at: AT },
      }),
    );
    expect(find(result, SEEDANCE_FAL).factors.price?.value).toBe(1);
    expect(find(result, SEEDANCE_FAL).unranked_quote).toBeUndefined();
    expect(find(result, SEEDANCE_ATLAS).factors.price).toBeUndefined();
  });

  it("names both the setting to pin and the other reasons of an unranked quote", () => {
    // An estimate whose card fixes 720p, compared without a pinned resolution.
    const result = recommend(
      input({ request: { task: "video", duration_s: 5, aspect_ratio: "16:9", at: AT } }),
    );
    const atlas = find(result, SEEDANCE_ATLAS);
    expect(atlas.unranked_quote?.reasons).toEqual([
      "pin resolution 480p",
      "the provider shows this price as an estimate and bills the final amount from the usage it measures",
    ]);
  });

  it("scores the mean of the evidenced factors times their coverage", () => {
    const result = recommend(
      input({
        usage: [usage(SEEDANCE_FAL, 5, 5)],
        reviews: [rating(SEEDANCE_FAL, 5), rating(SEEDANCE_FAL, 5), rating(SEEDANCE_FAL, 5)],
      }),
    );
    const rec = find(result, SEEDANCE_FAL);
    // reliability 1.0 (0.35) + rating 1.0 (0.25) + price 1.0 (0.2) over 0.8 of weight, times the 0.8 coverage.
    expect(rec.coverage).toBe(0.8);
    expect(rec.score).toBe(0.8);
    expect(rec.reasons).toEqual([]);
  });

  it("gives an offering with no evidence a score and coverage of zero", () => {
    const result = recommend(input({ request: { task: "video", at: AT } }));
    const bare = find(result, SEEDANCE_ATLAS);
    expect(bare).toMatchObject({ score: 0, coverage: 0, quote_usd: null });
    expect(bare.reasons).toEqual([
      "reliability: 0 operations (needs 5)",
      "rating: 0 ratings (needs 3)",
      "price: no comparable quote for this request",
    ]);
  });

  it("sums the coverage of the factors it has and reports the ones it lacks", () => {
    const rec = find(
      recommend(input({ notes: [note(SEEDANCE_FAL, "product-ugc", "recommended")] })),
      SEEDANCE_FAL,
    );
    expect(rec.coverage).toBe(0.4);
    expect(rec.reasons).toEqual([
      "reliability: 0 operations (needs 5)",
      "rating: 0 ratings (needs 3)",
    ]);
  });

  it("marks a provider without a key and says so", () => {
    const rec = find(recommend(input({ ready: FAL_ONLY })), SEEDANCE_ATLAS);
    expect(rec.ready).toBe(false);
    expect(rec.reasons).toContain("provider key not set");
  });
});

describe("candidates and ordering", () => {
  it("only recommends offerings for the requested task", () => {
    const rows = recommend(input({ request: { task: "video", at: AT } })).recommendations;
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every((r) => offerings.find((o) => o.id === r.offering)?.tasks.includes("video")),
    ).toBe(true);
  });

  it("drops offerings whose provider has no key when asked for ready ones only", () => {
    const rows = recommend(input({ ready: FAL_ONLY, ready_only: true })).recommendations;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.provider === "fal")).toBe(true);
  });

  it("puts the highest score first", () => {
    const result = recommend(input({ usage: [usage(SEEDANCE_FAL, 5, 5)] }));
    expect(result.recommendations[0]?.offering).toBe(SEEDANCE_FAL);
  });

  it("breaks a tie in score by the ready provider first, then by id", () => {
    const rows = recommend(
      input({ ready: FAL_ONLY, request: { task: "video", at: AT } }),
    ).recommendations;
    const firstNotReady = rows.findIndex((r) => !r.ready);
    const lastReady = rows.findLastIndex((r) => r.ready);
    expect(lastReady).toBeLessThan(firstNotReady);
    const zeroFal = rows.filter((r) => r.score === 0 && r.ready).map((r) => r.offering);
    expect(zeroFal).toEqual([...zeroFal].sort());
  });

  it("states the scoring basis in its note and echoes the task and use case", () => {
    const result = recommend(input({ use_case: "product-ugc" }));
    expect(result).toMatchObject({ task: "video", use_case: "product-ugc" });
    expect(result.note).toContain("Price compares this exact request only.");
  });
});
