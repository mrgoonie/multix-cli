/**
 * Versioned contract of the model & provider catalogue (`multix.catalog/v1`).
 * Official facts (capabilities, rate cards with their sources) are kept apart
 * from what multix observed (usage from the run ledger) and from what people
 * wrote (ratings, reviews, use-case notes). Runtime-neutral: the CLI and the
 * MCP Worker read the same types.
 */

import type { PriceComponent, PriceEntry, PriceMeter } from "../budget/pricing-catalog.js";
import type { Task } from "../capabilities/capability-types.js";

export const CATALOG_SCHEMA = "multix.catalog/v1";

/**
 * The configuration a price applies to. A field that is absent means the
 * source does not state it: such a price is never compared as if it did.
 */
export interface OfferingConfig {
  /** Native output resolution as the provider names it (480p, 720p, 1080p, 4k). */
  resolution?: string;
  /** Generated audio on or off. */
  audio?: boolean;
  /** Aspect ratio the price or token formula assumes (16:9). */
  aspect_ratio?: string;
  /** Extra metered option the price includes (e.g. "voice-control"). */
  variant?: string;
}

export type ConfigKey = keyof OfferingConfig;
export const CONFIG_KEYS: readonly ConfigKey[] = ["resolution", "audio", "aspect_ratio", "variant"];

/**
 * A provider price for one model in one configuration: a `PriceEntry` (dated
 * windows, source, last_checked, verified) plus what it applies to.
 */
export interface RateCard extends PriceEntry {
  /** Canonical model family shared across providers ("seedance-2.5"). */
  family: string;
  task: Task;
  config: OfferingConfig;
  /** Dimensions the source says do not change this price ("regardless of audio"). */
  config_independent?: readonly ConfigKey[];
  /**
   * list: the price the provider bills per unit. estimated: the provider shows
   * this as an estimate and bills the final amount from usage it measures.
   */
  basis: "list" | "estimated";
  /** Frame rate in the token formula of a `video_tokens` price. */
  token_fps?: number;
}

/** Why a price cannot be used right now (mirrors resolveRate). */
export type RateProblem = "no_price" | "unverified" | "stale" | "no_window";

/** One price as a catalogue reader sees it: in force now, or why not. */
export interface RateView {
  id: string;
  status: "current" | RateProblem;
  detail?: string;
  tier: string;
  currency: "USD";
  basis: "list" | "estimated";
  config: OfferingConfig;
  config_independent?: readonly ConfigKey[];
  /** Frame rate of a `video_tokens` price's token formula. */
  token_fps?: number;
  /** Price in force now; absent when status is not "current". */
  components?: PriceComponent[];
  /** Human unit summary, e.g. "USD 0.0214 per 1000 video_tokens". */
  units: string[];
  label?: string;
  effective_from?: string;
  effective_until?: string;
  last_checked: string;
  source: string;
  notes?: string;
}

/** One provider route for one model: what multix runs and what it costs. */
export interface Offering {
  /** "<provider>:<model>", the id `catalog show` takes. */
  id: string;
  provider: string;
  model: string;
  family?: string;
  name?: string;
  tasks: Task[];
  /** multix command that runs it. */
  command?: string;
  /** True when multix checked the model's inputs against the provider schema. */
  verified_capability: boolean;
  rates: RateView[];
  /** Overall price state: priced (a current rate), or the first problem found. */
  price_status: "priced" | RateProblem;
}

export interface ProviderView {
  id: string;
  name: string;
  homepage?: string;
  pricing_url?: string;
  docs_url?: string;
  /** Whether the caller has the keys this provider needs (never key values). */
  ready: boolean;
  offerings: number;
  priced_offerings: number;
}

/** Inputs of one configuration-aware quote. */
export interface QuoteRequest {
  task?: Task;
  resolution?: string;
  duration_s?: number;
  audio?: boolean;
  aspect_ratio?: string;
  /** Images to return (image prices). */
  images?: number;
  at?: Date;
}

export interface QuoteRow {
  offering: string;
  provider: string;
  model: string;
  rate_id?: string;
  /** priced: comparable and computed; not_comparable: config differs or is unconfirmed; unknown: no usable price. */
  status: "priced" | "not_comparable" | "unknown";
  total_usd: number | null;
  basis?: "list" | "estimated";
  units?: Partial<Record<PriceMeter, number>>;
  /** What the quote assumed (e.g. 16:9 frame size for a token formula). */
  assumptions?: string[];
  /** Settings the rate card fixes that the request left open; pin them to rank this row. */
  open_settings?: string[];
  reasons?: string[];
  source?: string;
  last_checked?: string;
  /** 1 = lowest quote among priced rows; absent for rows that are not ranked. */
  price_rank?: number;
}

export type ReviewScope = "private" | "project";
export const REVIEW_SCOPES: readonly ReviewScope[] = ["private", "project"];

export const REVIEW_ASPECTS = [
  "quality",
  "fidelity",
  "motion",
  "audio",
  "speed",
  "value",
  "reliability",
] as const;
export type ReviewAspect = (typeof REVIEW_ASPECTS)[number];

/** A person's rating and/or written review of one offering for one use case. */
export interface Review {
  id: string;
  offering: string;
  use_case?: string;
  /** 1–5 stars; absent for a text-only review. */
  score?: number;
  aspects?: Partial<Record<ReviewAspect, number>>;
  text?: string;
  pros?: string[];
  cons?: string[];
  tags?: string[];
  /** Model version the review is about, when the reviewer states it. */
  version?: string;
  scope: ReviewScope;
  /** Set when the review points at a successful run of this offering in the run ledger. */
  verified_usage?: { history_id: string; ts: string };
  created_at: string;
  updated_at: string;
}

/** Structured "use for / avoid for" note about one offering. */
export interface UseCaseNote {
  id: string;
  offering: string;
  use_case: string;
  verdict: "recommended" | "avoid" | "mixed";
  text?: string;
  strengths?: string[];
  weaknesses?: string[];
  limitations?: string[];
  tags?: string[];
  version?: string;
  source?: string;
  scope: ReviewScope;
  created_at: string;
  updated_at: string;
}
