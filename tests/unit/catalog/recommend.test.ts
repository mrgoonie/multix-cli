/**
 * Recommendations: candidates are ordered by fixed criteria, each reason or
 * caveat carries its evidence, thin evidence is shown but does not move the
 * order, and price only breaks ties. Inputs are built in memory.
 */

import { describe, expect, it } from "vitest";
import type { OfferingView, Quote } from "../../../src/catalog/catalog-types.js";
import { type Feedback, MIN_RATINGS_FOR_MEAN } from "../../../src/catalog/feedback-rules.js";
import {
  MIN_RUNS_FOR_RELIABILITY,
  type RecommendInput,
  recommend,
} from "../../../src/catalog/recommend.js";
import type { UsageRow } from "../../../src/catalog/usage-analytics.js";

const ALL_READY = () => true;

function offer(provider: string, model: string, over: Partial<OfferingView> = {}): OfferingView {
  return {
    ref: `${provider}:${model}`,
    provider,
    model,
    family: model,
    tasks: ["video"],
    verified: true,
    command: `${provider} video`,
    price_status: "priced",
    rates: 1,
    ...over,
  };
}

function quoted(o: OfferingView, amount: number): Quote {
  return {
    ref: o.ref,
    provider: o.provider,
    model: o.model,
    status: "quoted",
    amount,
    currency: "USD",
    basis: `10 s x ${amount / 10} USD/video_second`,
    source: "https://example.test/pricing",
  };
}

function feedbackOn(o: OfferingView, over: Partial<Feedback> & Pick<Feedback, "kind">): Feedback {
  return {
    id: `fb_${o.ref}_${over.kind}_${Math.random().toString(36).slice(2, 7)}`,
    ref: o.ref,
    provider: o.provider,
    model: o.model,
    scope: "private",
    created_at: "2026-10-27T10:00:00.000Z",
    updated_at: "2026-10-27T10:00:00.000Z",
    ...over,
  };
}

function rating(o: OfferingView, score: number, n = 1): Feedback[] {
  return Array.from({ length: n }, () => feedbackOn(o, { kind: "rating", score }));
}

function note(
  o: OfferingView,
  verdict: "use" | "avoid",
  at: string,
  use_case = "product-ugc",
): Feedback {
  return feedbackOn(o, { kind: "note", verdict, use_case, updated_at: at, created_at: at });
}

function usage(o: OfferingView, operations: number, success_rate: number): UsageRow {
  return {
    key: o.ref,
    runs: operations,
    operations,
    attempts: operations,
    completed: Math.round(operations * success_rate),
    failed: 0,
    canceled: 0,
    success_rate,
    retry_rate: 0,
    latency_s: { p50: 12, p95: 30 },
    outputs: 0,
    cost: {
      actual_usd: null,
      estimated_usd: null,
      actual_ops: 0,
      estimated_only_ops: 0,
      uncertain_ops: 0,
      unknown_ops: operations,
    },
    cost_per_success_usd: null,
    sample: { operations, confidence: "insufficient" },
    first_at: "2026-10-27T10:00:00.000Z",
    last_at: "2026-10-27T10:00:00.000Z",
  } as UsageRow;
}

function input(over: Partial<RecommendInput> & Pick<RecommendInput, "offerings">): RecommendInput {
  return {
    task: "video",
    quotes: new Map(),
    usage: new Map(),
    feedback: [],
    ready: ALL_READY,
    ...over,
  };
}

const refsOf = (r: ReturnType<typeof recommend>) => r.recommendations.map((x) => x.ref);

describe("recommend ordering", () => {
  it("does not rank the cheapest candidate first when another is verified, ready and better rated", () => {
    const cheap = offer("cheapprov", "cheap-model", { verified: false });
    const solid = offer("solidprov", "solid-model", { verified: true });
    const result = recommend(
      input({
        offerings: [cheap, solid],
        quotes: new Map([
          [cheap.ref, quoted(cheap, 0.5)],
          [solid.ref, quoted(solid, 2)],
        ]),
        feedback: [...rating(solid, 5, 3), ...rating(cheap, 2, 3)],
        ready: (p) => p === "solidprov",
      }),
    );
    expect(refsOf(result)).toEqual([solid.ref, cheap.ref]);
    const cheapRec = result.recommendations[1];
    expect(cheapRec?.caveats).toEqual(
      expect.arrayContaining([
        "not verified by multix: check its inputs first",
        "no cheapprov key set",
      ]),
    );
    expect(cheapRec?.reasons).toEqual(
      expect.arrayContaining([
        "list price 0.5 USD for this configuration (10 s x 0.05 USD/video_second)",
      ]),
    );
  });

  it("uses price only as a tie-breaker between otherwise equal candidates", () => {
    // The pricey candidate sorts first by ref, so only the price can put the cheap one first.
    const pricey = offer("prov", "a-model");
    const cheap = offer("prov", "b-model");
    const tied = recommend(
      input({
        offerings: [pricey, cheap],
        quotes: new Map([
          [pricey.ref, quoted(pricey, 3)],
          [cheap.ref, quoted(cheap, 1)],
        ]),
      }),
    );
    expect(refsOf(tied)).toEqual([cheap.ref, pricey.ref]);
  });

  it("falls back to ref order when nothing else separates the candidates", () => {
    const a = offer("prov", "a-model");
    const b = offer("prov", "b-model");
    expect(refsOf(recommend(input({ offerings: [b, a] })))).toEqual([a.ref, b.ref]);
  });

  it("orders readiness first, then verification", () => {
    const readyUnverified = offer("readyprov", "m1", { verified: false });
    const verifiedNotReady = offer("notready", "m2", { verified: true });
    const result = recommend(
      input({
        offerings: [verifiedNotReady, readyUnverified],
        ready: (p) => p === "readyprov",
      }),
    );
    expect(refsOf(result)).toEqual([readyUnverified.ref, verifiedNotReady.ref]);
    expect(result.recommendations[1]?.caveats).toContain("no notready key set");
  });

  it("sends a candidate with a deprecated flag to a caveat, not out of the list", () => {
    const old = offer("prov", "old-model", { deprecated: true });
    const result = recommend(input({ offerings: [old] }));
    expect(result.recommendations[0]?.caveats).toContain("deprecated");
  });
});

describe("recommend notes", () => {
  it("sinks an offering the user marked avoid for the use case, even when it is cheapest and verified", () => {
    const avoided = offer("cheapprov", "avoided-model");
    const other = offer("prov", "other-model");
    const result = recommend(
      input({
        offerings: [avoided, other],
        quotes: new Map([
          [avoided.ref, quoted(avoided, 0.5)],
          [other.ref, quoted(other, 2)],
        ]),
        use_case: "product-ugc",
        feedback: [note(avoided, "avoid", "2026-10-27T10:00:00.000Z")],
      }),
    );
    expect(refsOf(result)).toEqual([other.ref, avoided.ref]);
    const last = result.recommendations[1];
    expect(last?.caveats).toContain("your note: avoid for product-ugc");
    expect(last?.evidence.own_note).toBe("avoid");
  });

  it("lifts an offering the user marked use for the use case above a cheaper one", () => {
    const cheap = offer("cheapprov", "cheap-model");
    const liked = offer("prov", "liked-model");
    const result = recommend(
      input({
        offerings: [cheap, liked],
        quotes: new Map([
          [cheap.ref, quoted(cheap, 0.5)],
          [liked.ref, quoted(liked, 2)],
        ]),
        use_case: "product-ugc",
        feedback: [note(liked, "use", "2026-10-27T10:00:00.000Z")],
      }),
    );
    expect(refsOf(result)).toEqual([liked.ref, cheap.ref]);
    expect(result.recommendations[0]?.reasons).toContain("your note: use for product-ugc");
    expect(result.recommendations[0]?.evidence.own_note).toBe("use");
  });

  it("applies only the latest note for the use case", () => {
    const o = offer("prov", "changed-mind");
    const result = recommend(
      input({
        offerings: [o],
        use_case: "product-ugc",
        feedback: [
          note(o, "use", "2026-10-26T10:00:00.000Z"),
          note(o, "avoid", "2026-10-27T10:00:00.000Z"),
        ],
      }),
    );
    expect(result.recommendations[0]?.evidence.own_note).toBe("avoid");
  });

  it("ignores a note for another use case", () => {
    const a = offer("prov", "a-model");
    const b = offer("prov", "b-model");
    const result = recommend(
      input({
        offerings: [b, a],
        use_case: "product-ugc",
        feedback: [note(a, "avoid", "2026-10-27T10:00:00.000Z", "vietnamese-tts")],
      }),
    );
    expect(refsOf(result)).toEqual([a.ref, b.ref]);
  });
});

describe("recommend thin evidence", () => {
  it("shows two ratings as a caveat and lets the order stand when nothing else differs", () => {
    const a = offer("prov", "a-model");
    const b = offer("prov", "b-model");
    const result = recommend(input({ offerings: [b, a], feedback: rating(a, 5, 2) }));
    expect(refsOf(result)).toEqual([a.ref, b.ref]);
    expect(result.recommendations[0]?.caveats).toContain("only 2 rating(s): too few to weigh");
    expect(result.recommendations[0]?.evidence.ratings.mean).toBeNull();
  });

  it("uses the mean once there are enough ratings", () => {
    expect(MIN_RATINGS_FOR_MEAN).toBe(3);
    const a = offer("prov", "a-model");
    const b = offer("prov", "b-model");
    const result = recommend(
      input({ offerings: [a, b], feedback: [...rating(a, 3, 3), ...rating(b, 4, 3)] }),
    );
    expect(refsOf(result)).toEqual([b.ref, a.ref]);
    expect(result.recommendations[0]?.reasons).toContain(
      "rated 4/5 from 3 rating(s) (insufficient confidence)",
    );
  });

  it("counts too few ratings as neutral: below a solid 4/5, above a solid 1/5", () => {
    const thin = offer("prov", "a-model");
    const good = offer("prov", "b-model");
    const poor = offer("prov", "c-model");
    const result = recommend(
      input({
        offerings: [poor, thin, good],
        feedback: [...rating(thin, 5, 2), ...rating(good, 4, 3), ...rating(poor, 1, 3)],
      }),
    );
    expect(refsOf(result)).toEqual([good.ref, thin.ref, poor.ref]);
  });

  it("keeps a candidate with four runs in the order it would have without them", () => {
    expect(MIN_RUNS_FOR_RELIABILITY).toBe(5);
    const a = offer("prov", "a-model");
    const b = offer("prov", "b-model");
    const result = recommend(
      input({ offerings: [b, a], usage: new Map([[a.ref, usage(a, 4, 1)]]) }),
    );
    expect(refsOf(result)).toEqual([a.ref, b.ref]);
    expect(result.recommendations[0]?.caveats).toContain(
      "100% success over 4 run(s) through multix: too few to weigh",
    );
  });

  // Fewer than MIN_RUNS_FOR_RELIABILITY operations count as the neutral 50%,
  // so they tie with 10 runs at 50% and the ref order decides.
  it("does not move a candidate with four runs below one with ten runs at 50%", () => {
    const a = offer("prov", "a-model");
    const b = offer("prov", "b-model");
    const result = recommend(
      input({
        offerings: [b, a],
        usage: new Map([
          [a.ref, usage(a, 4, 1)],
          [b.ref, usage(b, 10, 0.5)],
        ]),
      }),
    );
    expect(refsOf(result)).toEqual([a.ref, b.ref]);
  });

  it("orders by observed success once there are enough runs", () => {
    const a = offer("prov", "a-model");
    const b = offer("prov", "b-model");
    const result = recommend(
      input({
        offerings: [a, b],
        usage: new Map([
          [a.ref, usage(a, 10, 0.5)],
          [b.ref, usage(b, 10, 0.9)],
        ]),
      }),
    );
    expect(refsOf(result)).toEqual([b.ref, a.ref]);
    expect(result.recommendations[0]?.evidence.reliability).toEqual({
      success_rate: 0.9,
      operations: 10,
      p50_s: 12,
    });
  });
});

describe("recommend evidence and output", () => {
  it("says the price is unknown when no quote and no sourced rate exist", () => {
    const o = offer("prov", "m", { price_status: "unknown", rates: 0 });
    const rec = recommend(input({ offerings: [o] })).recommendations[0];
    expect(rec?.caveats).toContain("price unknown");
    expect(rec?.evidence.price).toEqual({ status: "unknown" });
  });

  it("gives the reason a quote was not made, not a price", () => {
    const o = offer("prov", "m");
    const rec = recommend(
      input({
        offerings: [o],
        quotes: new Map([
          [
            o.ref,
            {
              ...quoted(o, 1),
              status: "unit_only",
              amount: null,
              reason: "give --duration to price a clip",
            },
          ],
        ]),
      }),
    ).recommendations[0];
    expect(rec?.caveats).toContain("price: give --duration to price a clip");
    expect(rec?.evidence.price).toMatchObject({ status: "unit_only", amount: null });
  });

  it("keeps only offerings with the task and honours the limit", () => {
    const video = [offer("prov", "v1"), offer("prov", "v2"), offer("prov", "v3")];
    const speech = offer("prov", "s1", { tasks: ["speech"] });
    const result = recommend(input({ offerings: [speech, ...video], limit: 2 }));
    expect(result.recommendations).toHaveLength(2);
    expect(refsOf(result).every((r) => r !== speech.ref)).toBe(true);
    expect(result.recommendations.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("reports the schema, task, use case and the full ranking basis", () => {
    const result = recommend(input({ offerings: [], use_case: "product-ugc" }));
    expect(result).toMatchObject({
      schema: "multix.catalog/v1",
      task: "video",
      use_case: "product-ugc",
      recommendations: [],
    });
    expect(result.ranking_basis).toHaveLength(7);
    expect(result.ranking_basis.at(-1)).toContain("tie-breaker");
    expect(recommend(input({ offerings: [] })).use_case).toBeNull();
  });
});
