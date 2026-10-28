/**
 * Explainable model suggestions for a task and use case. There is no blended
 * score: candidates are ordered by a fixed list of criteria, each backed by
 * evidence that is reported next to it with its sample size, and evidence too
 * thin to lean on (fewer ratings or runs than the thresholds) is shown but
 * does not move the order. Price is the last criterion, a tie-breaker between
 * otherwise equal candidates, so the cheapest offering is never the default
 * answer. The user's own "avoid" note for the use case sends an offering to
 * the end; their "use" note lifts it, and both are labelled as personal notes.
 *
 * Runtime-neutral: it ranks the data it is given.
 */

import type { Task } from "../capabilities/capability-types.js";
import { CATALOG_SCHEMA, type OfferingView, type Quote } from "./catalog-types.js";
import { type Feedback, MIN_RATINGS_FOR_MEAN, summariseRatings } from "./feedback-rules.js";
import type { UsageRow } from "./usage-analytics.js";

/** Operations needed before an observed success rate orders candidates. */
export const MIN_RUNS_FOR_RELIABILITY = 5;

/** Where an offering without enough ratings or runs sorts: the scale midpoints. */
const NEUTRAL_RATING = 3;
const NEUTRAL_SUCCESS = 0.5;

export interface RecommendInput {
  task: Task;
  use_case?: string;
  offerings: OfferingView[];
  /** Quote per offering ref at the requested configuration, when one was asked for. */
  quotes: Map<string, Quote>;
  /** Usage rows keyed "<provider>:<model>". */
  usage: Map<string, UsageRow>;
  feedback: Feedback[];
  ready: (provider: string) => boolean | null;
  limit?: number;
}

export interface Recommendation {
  rank: number;
  ref: string;
  command: string | null;
  reasons: string[];
  caveats: string[];
  evidence: {
    key_ready: boolean | null;
    verified: boolean;
    price: Pick<Quote, "status" | "amount" | "currency" | "basis" | "source"> | { status: string };
    reliability: { success_rate: number | null; operations: number; p50_s: number | null } | null;
    ratings: ReturnType<typeof summariseRatings>;
    own_note: "use" | "avoid" | null;
  };
}

export interface RecommendResult {
  schema: typeof CATALOG_SCHEMA;
  task: Task;
  use_case: string | null;
  ranking_basis: string[];
  recommendations: Recommendation[];
}

const RANKING_BASIS = [
  "not marked avoid in your notes for this use case",
  "provider key ready",
  "verified by multix (inputs checked against the provider schema)",
  "marked use in your notes for this use case",
  `mean rating (only with ${MIN_RATINGS_FOR_MEAN}+ ratings; fewer count as ${NEUTRAL_RATING}/5)`,
  `observed success rate (only with ${MIN_RUNS_FOR_RELIABILITY}+ operations; fewer count as ${NEUTRAL_SUCCESS * 100}%)`,
  "lower quoted price for the same configuration (tie-breaker only)",
];

export function recommend(input: RecommendInput): RecommendResult {
  const rows = input.offerings
    .filter((o) => o.tasks.includes(input.task))
    .map((o) => {
      const mine = input.feedback.filter(
        (f) => f.ref === o.ref && (!input.use_case || !f.use_case || f.use_case === input.use_case),
      );
      const notes = mine.filter((f) => f.kind === "note" && f.use_case === input.use_case);
      const latestNote = notes.sort((a, b) => a.updated_at.localeCompare(b.updated_at)).at(-1);
      const ownNote = input.use_case ? (latestNote?.verdict ?? null) : null;
      const ratings = summariseRatings(mine.filter((f) => f.kind !== "note"));
      const usage = input.usage.get(o.ref);
      const quote = input.quotes.get(o.ref);
      const ready = input.ready(o.provider);
      const reasons: string[] = [];
      const caveats: string[] = [];
      if (ready === true) reasons.push(`${o.provider} key is set`);
      else if (ready === false) caveats.push(`no ${o.provider} key set`);
      if (o.verified) reasons.push("verified by multix");
      else caveats.push("not verified by multix: check its inputs first");
      if (ownNote === "use") reasons.push(`your note: use for ${input.use_case}`);
      if (ownNote === "avoid") caveats.push(`your note: avoid for ${input.use_case}`);
      if (ratings.mean !== null) {
        reasons.push(
          `rated ${ratings.mean}/5 from ${ratings.count} rating(s) (${ratings.confidence} confidence)`,
        );
      } else if (ratings.count) {
        caveats.push(`only ${ratings.count} rating(s): too few to weigh`);
      }
      const reliable = usage && usage.operations >= MIN_RUNS_FOR_RELIABILITY;
      if (usage && usage.success_rate !== null) {
        const line = `${Math.round(usage.success_rate * 100)}% success over ${usage.operations} run(s) through multix`;
        if (reliable) reasons.push(line);
        else caveats.push(`${line}: too few to weigh`);
      }
      if (quote?.status === "quoted") {
        reasons.push(
          `list price ${quote.amount} ${quote.currency} for this configuration (${quote.basis})`,
        );
      } else if (quote) {
        caveats.push(`price: ${quote.reason ?? quote.status}`);
      } else if (o.price_status !== "priced") {
        caveats.push(`price ${o.price_status}`);
      }
      if (o.deprecated) caveats.push("deprecated");
      return {
        o,
        ownNote,
        ready,
        ratings,
        usage,
        quote,
        reliable,
        reasons,
        caveats,
      };
    });
  const readyRank = (r: boolean | null) => (r === true ? 2 : r === null ? 1 : 0);
  // Missing or too-thin evidence sits at the neutral point, so it neither lifts
  // nor sinks a candidate: below a well-rated one, above a poorly rated one.
  const ratingKey = (r: (typeof rows)[number]) => r.ratings.mean ?? NEUTRAL_RATING;
  const reliabilityKey = (r: (typeof rows)[number]) =>
    r.reliable ? (r.usage?.success_rate ?? NEUTRAL_SUCCESS) : NEUTRAL_SUCCESS;
  rows.sort(
    (a, b) =>
      Number(a.ownNote === "avoid") - Number(b.ownNote === "avoid") ||
      readyRank(b.ready) - readyRank(a.ready) ||
      Number(b.o.verified) - Number(a.o.verified) ||
      Number(b.ownNote === "use") - Number(a.ownNote === "use") ||
      ratingKey(b) - ratingKey(a) ||
      reliabilityKey(b) - reliabilityKey(a) ||
      quoted(a.quote) - quoted(b.quote) ||
      a.o.ref.localeCompare(b.o.ref),
  );
  return {
    schema: CATALOG_SCHEMA,
    task: input.task,
    use_case: input.use_case ?? null,
    ranking_basis: RANKING_BASIS,
    recommendations: rows.slice(0, input.limit ?? 10).map((r, i) => ({
      rank: i + 1,
      ref: r.o.ref,
      command: r.o.command,
      reasons: r.reasons,
      caveats: r.caveats,
      evidence: {
        key_ready: r.ready,
        verified: r.o.verified,
        price: r.quote
          ? {
              status: r.quote.status,
              amount: r.quote.amount,
              currency: r.quote.currency,
              ...(r.quote.basis ? { basis: r.quote.basis } : {}),
              ...(r.quote.source ? { source: r.quote.source } : {}),
            }
          : { status: r.o.price_status },
        reliability: r.usage
          ? {
              success_rate: r.usage.success_rate,
              operations: r.usage.operations,
              p50_s: r.usage.latency_s?.p50 ?? null,
            }
          : null,
        ratings: r.ratings,
        own_note: r.ownNote,
      },
    })),
  };
}

/** Quoted USD amount for sorting; unquoted sorts last. */
function quoted(q: Quote | undefined): number {
  return q?.status === "quoted" && q.currency === "USD" && q.amount !== null
    ? q.amount
    : Number.POSITIVE_INFINITY;
}
