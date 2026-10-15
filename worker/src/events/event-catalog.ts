/**
 * Events the server publishes when a `multix_run` job ends, and their
 * envelope. The envelope follows the shared MCP Events contract
 * (bestagentkits/mcp-event-hub): a stable `id` per logical event, a
 * namespaced `name`, a schema version, the time it happened and the resource
 * it is about. The owning account never appears in a payload: it only picks
 * which account's subscriptions receive the event.
 *
 * Payloads carry identifiers and final state only. Prompts, CLI output, error
 * text, provider data and output URLs (often presigned) are left out; callers
 * read those with `multix_job_status` / `GET /api/v1/jobs/{id}`, which stays
 * the source of truth.
 */

export const EVENT_SCHEMA_VERSION = 1;

export const JOB_EVENT_NAMES = [
  "multix.job.completed",
  "multix.job.failed",
  "multix.job.canceled",
  "multix.job.timed_out",
] as const;

export const ASSET_READY_EVENT = "multix.asset.ready";

export const EVENT_NAMES = [...JOB_EVENT_NAMES, ASSET_READY_EVENT] as const;

export type JobEventName = (typeof JOB_EVENT_NAMES)[number];
export type EventName = (typeof EVENT_NAMES)[number];

export function isEventName(value: unknown): value is EventName {
  return typeof value === "string" && (EVENT_NAMES as readonly string[]).includes(value);
}

/** One output file of a job, without its URL. */
export interface EventOutput {
  name: string;
  bytes: number;
  /** Whether the file was uploaded to the account's R2 bucket. */
  stored: boolean;
}

export interface JobEventData {
  job_id: string;
  status: "succeeded" | "failed" | "canceled" | "timed_out";
  /** CLI command the job ran, e.g. "gemini generate". */
  command: string;
  /** Command group, which is the provider for provider commands, e.g. "gemini". */
  provider: string;
  created_at: string;
  finished_at: string;
  exit_code: number | null;
  outputs: EventOutput[];
}

export interface AssetReadyData {
  job_id: string;
  command: string;
  provider: string;
  /** Position of the file in the job's `outputs`. */
  index: number;
  name: string;
  bytes: number;
}

export interface MultixEvent {
  /** Stable per logical event; receivers dedupe on it (also sent as `webhook-id`). */
  id: string;
  name: EventName;
  schema_version: number;
  /** ISO 8601. */
  occurred_at: string;
  resource: { type: "job"; id: string };
  data: JobEventData | AssetReadyData;
}

const outputSchema = {
  type: "object",
  required: ["name", "bytes", "stored"],
  properties: {
    name: { type: "string" },
    bytes: { type: "integer" },
    stored: { type: "boolean" },
  },
} as const;

const jobDataSchema = {
  type: "object",
  required: [
    "job_id",
    "status",
    "command",
    "provider",
    "created_at",
    "finished_at",
    "exit_code",
    "outputs",
  ],
  properties: {
    job_id: { type: "string", format: "uuid" },
    status: { type: "string", enum: ["succeeded", "failed", "canceled", "timed_out"] },
    command: { type: "string" },
    provider: { type: "string" },
    created_at: { type: "string", format: "date-time" },
    finished_at: { type: "string", format: "date-time" },
    exit_code: { type: ["integer", "null"] },
    outputs: { type: "array", items: outputSchema },
  },
} as const;

const assetDataSchema = {
  type: "object",
  required: ["job_id", "command", "provider", "index", "name", "bytes"],
  properties: {
    job_id: { type: "string", format: "uuid" },
    command: { type: "string" },
    provider: { type: "string" },
    index: { type: "integer" },
    name: { type: "string" },
    bytes: { type: "integer" },
  },
} as const;

export interface EventCatalogEntry {
  name: EventName;
  description: string;
  schema_version: number;
  /** JSON Schema of the envelope's `data`. */
  data_schema: object;
}

export const EVENT_CATALOG: readonly EventCatalogEntry[] = [
  {
    name: "multix.job.completed",
    description: "A job finished and the CLI exited successfully.",
    schema_version: EVENT_SCHEMA_VERSION,
    data_schema: jobDataSchema,
  },
  {
    name: "multix.job.failed",
    description:
      "A job ended with an error (CLI failure, container lost, start failure). Read the error with multix_job_status.",
    schema_version: EVENT_SCHEMA_VERSION,
    data_schema: jobDataSchema,
  },
  {
    name: "multix.job.canceled",
    description: "A job was canceled by its owner.",
    schema_version: EVENT_SCHEMA_VERSION,
    data_schema: jobDataSchema,
  },
  {
    name: "multix.job.timed_out",
    description: "A job did not finish within the server's time limit.",
    schema_version: EVENT_SCHEMA_VERSION,
    data_schema: jobDataSchema,
  },
  {
    name: ASSET_READY_EVENT,
    description:
      "An output file of a successful job was stored in the account's R2 bucket. Get its URL with multix_job_status.",
    schema_version: EVENT_SCHEMA_VERSION,
    data_schema: assetDataSchema,
  },
];
