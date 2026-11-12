/**
 * Versioned contract for what multix can do, kept apart on three levels so
 * discovery never overstates a capability:
 * - command capability: what one CLI command does (tasks, outputs, how it picks a model);
 * - model capability: one model verified to work through a command (inputs, voices, formats);
 * - discovered model: one model a provider's catalog lists right now (not verified by multix).
 *
 * Runtime-neutral (no node:* imports): the CLI and the MCP Worker both read it.
 */

export const CAPABILITY_SCHEMA = "multix.capabilities/v1";

export const TASKS = [
  "image",
  "image-edit",
  "video",
  "image-to-video",
  "video-edit",
  "speech",
  "transcription",
  "music",
  "sfx",
  "voice",
  "3d",
  "analysis",
  "document",
  "avatar-video",
  "lipsync",
  "upscale",
  "any",
] as const;

export type Task = (typeof TASKS)[number];

export function isTask(value: string): value is Task {
  return (TASKS as readonly string[]).includes(value);
}

export type Modality = "image" | "video" | "audio" | "text" | "3d";

/**
 * How a command picks its model:
 * - "fixed": the provider's default or a short list the command names;
 * - "provider-catalog": any model id the provider serves for this command's
 *   outputs is passed through as given; multix has not verified those ids.
 */
export type ModelChoice = "fixed" | "provider-catalog";

export interface CommandCapability {
  tasks: readonly Task[];
  outputs: readonly Modality[];
  models: ModelChoice;
  /** For "provider-catalog": which ids the command takes, in words. */
  scope?: string;
}

export interface InputSpec {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array";
  required?: boolean;
  /** Accepted values when the provider lists them. */
  values?: readonly (string | number)[];
  default?: string | number | boolean;
  max_length?: number;
  note?: string;
}

/** A model multix has run through `command` and checked against the provider's schema. */
export interface ModelCapability {
  provider: string;
  model: string;
  name: string;
  tasks: readonly Task[];
  /** multix command that runs it; the model id is its first argument or --model. */
  command: string;
  /** Example invocation with the smallest valid input. */
  example: string;
  /** Input fields the endpoint accepts (fal: keys of --input). */
  inputs: Readonly<Record<string, InputSpec>>;
  /** Alternatives when no single field is required: one group must be fully given. */
  required_any?: readonly (readonly string[])[];
  outputs: readonly { field: string; modality: Modality; formats?: readonly string[] }[];
  /** Voice ids the endpoint accepts, or a note when it takes the provider's whole catalog. */
  voices?: readonly string[] | { examples: readonly string[]; note: string };
  /** Languages, or "auto" when the endpoint detects them. */
  languages?: readonly string[] | "auto";
  async: boolean;
  streaming?: boolean;
  limits?: Readonly<Record<string, number>>;
  deprecated?: boolean;
  /** Where the facts come from and when they were last checked. */
  source: { url: string; verified_at: string };
}

/** A model listed by a provider catalog at fetch time. */
export interface DiscoveredModel {
  provider: string;
  model: string;
  name?: string;
  task: Task;
  /** Provider-reported state ("active", "deprecated", ...), when it reports one. */
  status?: string;
  voices?: string[];
  /** Provider-reported prices, as strings in the provider's units. */
  pricing?: Record<string, string>;
  /** A per-run price list the provider publishes for this model (Atlas Cloud 3D). */
  price?: ListedPrice;
}

/** One configuration of a per-run price list. */
export interface ListedPriceRow {
  id: string;
  label?: string;
  usd: number;
  /** Billing unit as the provider writes it ("/pic", "/generation"). */
  unit?: string;
  /** The request settings this price applies to. */
  settings?: Record<string, string | number | boolean>;
}

/** A provider's per-run prices for one model, by configuration. */
export interface ListedPrice {
  rows: ListedPriceRow[];
  /** Price of a run with the model's default settings. */
  default_usd?: number;
  /** Request settings the provider says the price depends on. */
  settings?: string[];
  /** The provider quotes the final price at submit time from the full request. */
  quoted_at_run: boolean;
  source: string;
}

export type DiscoveryState = "fresh" | "cached" | "stale" | "unavailable" | "unsupported";

/** How one provider catalog was read for one task. */
export interface DiscoverySource {
  provider: string;
  task: Task;
  state: DiscoveryState;
  url?: string;
  fetched_at?: string;
  /** Set when the catalog had more pages than multix reads. */
  truncated?: boolean;
  error?: string;
}
