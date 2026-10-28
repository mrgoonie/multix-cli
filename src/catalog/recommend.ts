/**
 * Explainable recommendations for a task (and optionally a use case) from
 * what multix knows: observed reliability in the run ledger, the user's own
 * ratings, use-case notes and the quoted price for the request. Every factor
 * carries its evidence and sample size; a factor without enough evidence is
 * left out (its weight drops from the coverage) instead of being guessed.
 * Offerings noted "avoid" for the use case are excluded with the reason.
 * Runtime-neutral: the caller supplies usage rows, reviews and notes.
 */

import type { Offering, QuoteRequest, Review, UseCaseNote } from "./catalog-types.js";
import { compareOfferings } from "./price-compare.js";
import { summarizeReviews } from "./reviews.js";
import type { UsageRow } from "./usage-aggregate.js";

/** Minimum runs before reliability counts, and ratings before the average counts. */
export const MIN_RUNS = 5;
export const MIN_RATINGS = 3;

export const WEIGHTS = { reliability: 0.35, rating: 0.25, note: 0.2, price: 0.2 } as const;
type Factor = keyof typeof WEIGHTS;

export interface RecommendInput {
  offerings: Offering[];
  request: QuoteRequest;
  use_case?: string;
  usage: UsageRow[];
  reviews: Review[];
  notes: UseCaseNote[];
  ready: (provider: string) => boolean;
  /** Only providers the caller has keys for. */
  ready_only?: boolean;
}

export interface Recommendation {
  offering: string;
  provider: string;
  model: string;
  ready: boolean;
  /** Weighted mean of the factors with evidence, 0–1, times coverage. */
  score: number;
  /** Share of the total weight backed by evidence (0–1). */
  coverage: number;
  factors: Partial<Record<Factor, { value: number; weight: number; evidence: string }>>;
  quote_usd: number | null;
  reasons: string[];
}

export interface RecommendResult {
  task?: string;
  use_case?: string;
  recommendations: Recommendation[];
  excluded: Array<{ offering: string; reason: string }>;
  note: string;
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

export function recommend(input: RecommendInput): RecommendResult {
  const { request, use_case } = input;
  const candidates = input.offerings.filter(
    (o) =>
      (!request.task || o.tasks.includes(request.task)) &&
      (!input.ready_only || input.ready(o.provider)),
  );
  const notesFor = (id: string) =>
    input.notes.filter((n) => n.offering === id && (!use_case || n.use_case === use_case));
  const excluded: RecommendResult["excluded"] = [];
  const kept = candidates.filter((o) => {
    const avoid = use_case ? notesFor(o.id).find((n) => n.verdict === "avoid") : undefined;
    if (avoid) excluded.push({ offering: o.id, reason: `noted "avoid" for ${use_case}` });
    return !avoid;
  });

  // Cheapest comparable quote per offering for this exact request.
  const comparison = compareOfferings(kept, request);
  const quote = new Map<string, number>();
  for (const r of comparison.rows) {
    if (r.price_rank === undefined || r.total_usd === null) continue;
    const prev = quote.get(r.offering);
    if (prev === undefined || r.total_usd < prev) quote.set(r.offering, r.total_usd);
  }
  const prices = [...quote.values()];
  const [lo, hi] = [Math.min(...prices), Math.max(...prices)];
  const usage = new Map(input.usage.map((u) => [u.key, u]));

  const recommendations = kept.map((o): Recommendation => {
    const factors: Recommendation["factors"] = {};
    const reasons: string[] = [];
    const u = usage.get(o.id);
    if (u && u.requests >= MIN_RUNS && u.success_rate !== null) {
      factors.reliability = {
        value: u.success_rate,
        weight: WEIGHTS.reliability,
        evidence: `${u.completed}/${u.requests} runs completed through multix`,
      };
    } else reasons.push(`reliability: ${u?.requests ?? 0} runs (needs ${MIN_RUNS})`);

    const own = input.reviews.filter(
      (r) => r.offering === o.id && (!use_case || r.use_case === use_case),
    );
    const summary = summarizeReviews(own);
    if (summary.average !== null && summary.rated >= MIN_RATINGS) {
      factors.rating = {
        value: (summary.average - 1) / 4,
        weight: WEIGHTS.rating,
        evidence: `average ${summary.average}/5 from ${summary.rated} ratings (${summary.verified} tied to a run)`,
      };
    } else reasons.push(`rating: ${summary.rated} ratings (needs ${MIN_RATINGS})`);

    const notes = notesFor(o.id);
    if (notes.length) {
      const value =
        notes.reduce((s, n) => s + (n.verdict === "recommended" ? 1 : 0.5), 0) / notes.length;
      factors.note = {
        value,
        weight: WEIGHTS.note,
        evidence: notes.map((n) => `${n.verdict} for ${n.use_case}`).join("; "),
      };
    }

    const q = quote.get(o.id);
    if (q !== undefined) {
      factors.price = {
        value: hi === lo ? 1 : 1 - (q - lo) / (hi - lo),
        weight: WEIGHTS.price,
        evidence: `quoted $${q} for this request (range $${lo}–$${hi})`,
      };
    } else reasons.push("price: no comparable quote for this request");

    const used = Object.values(factors);
    const coverage = used.reduce((s, f) => s + f.weight, 0);
    const mean = coverage ? used.reduce((s, f) => s + f.value * f.weight, 0) / coverage : 0;
    const ready = input.ready(o.provider);
    if (!ready) reasons.push("provider key not set");
    return {
      offering: o.id,
      provider: o.provider,
      model: o.model,
      ready,
      score: round(mean * coverage),
      coverage: round(coverage),
      factors,
      quote_usd: q ?? null,
      reasons,
    };
  });

  recommendations.sort(
    (a, b) =>
      b.score - a.score ||
      b.coverage - a.coverage ||
      Number(b.ready) - Number(a.ready) ||
      a.offering.localeCompare(b.offering),
  );
  return {
    ...(request.task ? { task: request.task } : {}),
    ...(use_case ? { use_case } : {}),
    recommendations,
    excluded,
    note: "Scores combine only the evidence shown per factor; coverage is how much of the weight had evidence. Price compares this exact request only.",
  };
}
