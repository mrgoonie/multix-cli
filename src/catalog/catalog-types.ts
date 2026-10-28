/**
 * Versioned contract for `multix catalog` (`multix.catalog/v1`), kept apart on
 * four levels so a price never stands in for quality and an estimate never
 * stands in for a bill:
 * - provider: a CLI command group, its docs, pricing page and key readiness;
 * - offering: one provider + model (+ task) multix knows about, verified or priced;
 * - rate: one dated, sourced price for an offering under stated conditions;
 * - usage, ratings, reviews and use-case notes: observed or user-authored data
 *   about an offering, reported with sample size and never mixed into a rate.
 *
 * Runtime-neutral (no node:* imports): the CLI and the MCP Worker both read it.
 */

import type { Task } from "../capabilities/capability-types.js";

export const CATALOG_SCHEMA = "multix.catalog/v1";

/**
 * How far a rate can be trusted at the time asked:
 * - current: verified, in its price window and checked within MAX_PRICE_AGE_DAYS;
 * - stale: verified but not re-checked for longer than that;
 * - unverified: on file for reference only, never used to price a run;
 * - expired / not_started: its price window does not cover the time asked.
 */
export type RateFreshness = "current" | "stale" | "unverified" | "expired" | "not_started";

/** What one unit of a rate is. Token and character meters come from the pricing catalogue. */
export type RateUnit =
  | "video_second"
  | "video"
  | "image"
  | "megapixel"
  | "request"
  | "input_text_tokens"
  | "output_audio_tokens"
  | "output_video_tokens"
  | "characters"
  | "utf8_bytes"
  | "input_audio_seconds"
  | "output_audio_seconds"
  | "requests";

/** Configuration a rate applies to; a field left out means the source does not narrow it. */
export interface RateConditions {
  /** text-to-video, image-to-video, ... (a Task). */
  mode?: Task;
  /** Output resolution as the provider names it (480p, 720p, 1080p, 1024x1024). */
  resolution?: string;
  /** Output aspect ratio the price is stated for (16:9), when the source names one. */
  aspect_ratio?: string;
  /** Whether generated audio is on; "any" when the source says the price is the same either way. */
  audio?: boolean | "any";
  /** Inclusive duration range the rate covers, in seconds. */
  min_duration_s?: number;
  max_duration_s?: number;
  /** Shortest duration billed, when the provider rounds a short clip up. */
  billed_min_duration_s?: number;
}

export interface RateComponent {
  unit: RateUnit;
  /** Price for `per` units, in `currency`. */
  amount: number;
  per: number;
}

/** One sourced price for an offering, as the catalogue reports it. */
export interface RateView {
  id: string;
  provider: string;
  model: string;
  family: string;
  task?: Task;
  conditions: RateConditions;
  components: RateComponent[];
  /** USD, or "credits" for a provider's own credits (never converted unless the source gives a rate). */
  currency: "USD" | "credits";
  /** USD per credit, only when the provider publishes it. */
  usd_per_credit?: number;
  /** Pay-as-you-go API usage vs a subscription or credit plan. */
  billing: "api-payg" | "credit-plan" | "subscription";
  tier: string;
  region: string;
  effective_from?: string;
  effective_until?: string;
  label?: string;
  last_checked: string;
  source: string;
  freshness: RateFreshness;
  /** Surcharges or fees the source names alongside the price (top-up fees, audio add-ons). */
  surcharges?: string[];
  notes?: string;
}

/** Provider identity: a CLI command group. */
export interface ProviderView {
  provider: string;
  name: string;
  homepage?: string;
  docs?: string;
  pricing?: string;
  tasks: Task[];
  commands: string[];
  /** Key env names the group reads (alternatives joined by "|"). */
  keys: string[];
  /** Whether the caller has the keys; null when the surface cannot tell. */
  ready: boolean | null;
  offerings: number;
  priced_offerings: number;
}

export type PriceStatus = "priced" | "stale" | "unverified" | "unknown";

/** One provider + model route multix knows about. */
export interface OfferingView {
  /** "<provider>:<model>" — the ref `multix catalog show` takes. */
  ref: string;
  provider: string;
  model: string;
  name?: string;
  family: string;
  tasks: Task[];
  /** In the verified capability registry (inputs checked against the provider's schema). */
  verified: boolean;
  /** multix command that runs it, or null when none is known to. */
  command: string | null;
  deprecated?: boolean;
  /** Best freshness among its rates; "unknown" when none is on file (never $0). */
  price_status: PriceStatus;
  rates: number;
}

/** Configuration to quote and compare at; fields left out are not assumed. */
export interface QuoteConfig {
  task?: Task;
  resolution?: string;
  duration_s?: number;
  aspect_ratio?: string;
  audio?: boolean;
  /** Images to generate (per-image rates). */
  count?: number;
}

export type QuoteStatus =
  /** A total for the configuration, from a current rate whose conditions match. */
  | "quoted"
  /** The rate matches but its unit needs a measurement multix cannot know up front (tokens). */
  | "unit_only"
  /** The rate's conditions do not match, or the source does not confirm them. */
  | "not_equivalent"
  /** No usable rate: unknown, stale, unverified or outside its window. */
  | "unknown";

export interface Quote {
  ref: string;
  provider: string;
  model: string;
  status: QuoteStatus;
  /** Total for the configuration, only when status is "quoted". */
  amount: number | null;
  currency: "USD" | "credits" | null;
  /** How the total was formed, e.g. "10 s x 0.05 USD/video_second". */
  basis?: string;
  rate_id?: string;
  freshness?: RateFreshness;
  last_checked?: string;
  source?: string;
  /** Conditions the source does not confirm for this configuration. */
  unconfirmed?: string[];
  /** Conditions the rate is stated for that the configuration left open (taken as given). */
  assumed?: string[];
  surcharges?: string[];
  reason?: string;
}
