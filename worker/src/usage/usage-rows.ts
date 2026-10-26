/** The `usage_events` row and its mapping to UsageEvent. */

import type { SqlRow } from "./sql-port.js";
import type {
  ChargeState,
  CostProvenance,
  UsageEvent,
  UsageOutput,
  UsageSource,
  UsageSpan,
  UsageStatus,
} from "./usage-types.js";

export interface EventRow extends SqlRow {
  id: string;
  schema_version: number;
  source: string;
  client_id: string | null;
  project: string | null;
  trace_id: string;
  job_id: string | null;
  history_id: string | null;
  command: string;
  provider: string;
  model_requested: string | null;
  model_resolved: string | null;
  attempt: number;
  status: string;
  error_code: string | null;
  error_reason: string | null;
  started_at: number;
  running_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  output_count: number | null;
  output_bytes: number | null;
  outputs_json: string | null;
  provider_ids_json: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_total: number | null;
  tokens_thinking: number | null;
  characters: number | null;
  audio_seconds: number | null;
  credits: number | null;
  credits_unit: string | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  currency: string;
  rate_source: string | null;
  rate_version: string | null;
  rate_effective: string | null;
  provenance: string;
  charge_state: string;
  metrics_json: string | null;
  spans_json: string | null;
  http_requests: number | null;
  http_errors: number | null;
  http_ms: number | null;
  settled: number;
  created_at: number;
  updated_at: number;
}

/** Columns in insert order; the ledger writes every column on insert. */
export const EVENT_COLUMNS = [
  "id",
  "schema_version",
  "source",
  "client_id",
  "project",
  "trace_id",
  "job_id",
  "history_id",
  "command",
  "provider",
  "model_requested",
  "model_resolved",
  "attempt",
  "status",
  "error_code",
  "error_reason",
  "started_at",
  "running_at",
  "finished_at",
  "duration_ms",
  "output_count",
  "output_bytes",
  "outputs_json",
  "provider_ids_json",
  "tokens_input",
  "tokens_output",
  "tokens_total",
  "tokens_thinking",
  "characters",
  "audio_seconds",
  "credits",
  "credits_unit",
  "estimated_cost_usd",
  "actual_cost_usd",
  "currency",
  "rate_source",
  "rate_version",
  "rate_effective",
  "provenance",
  "charge_state",
  "metrics_json",
  "spans_json",
  "http_requests",
  "http_errors",
  "http_ms",
  "settled",
  "created_at",
  "updated_at",
] as const satisfies readonly (keyof EventRow)[];

function parse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function toEvent(row: EventRow, adjustmentUsd = 0): UsageEvent {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    source: row.source as UsageSource,
    clientId: row.client_id,
    project: row.project,
    traceId: row.trace_id,
    jobId: row.job_id,
    historyId: row.history_id,
    command: row.command,
    provider: row.provider,
    modelRequested: row.model_requested,
    modelResolved: row.model_resolved,
    attempt: row.attempt,
    status: row.status as UsageStatus,
    errorCode: row.error_code,
    errorReason: row.error_reason,
    startedAt: row.started_at,
    runningAt: row.running_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    outputCount: row.output_count,
    outputBytes: row.output_bytes,
    outputs: parse<UsageOutput[]>(row.outputs_json, []),
    providerIds: parse<string[]>(row.provider_ids_json, []),
    tokensInput: row.tokens_input,
    tokensOutput: row.tokens_output,
    tokensTotal: row.tokens_total,
    tokensThinking: row.tokens_thinking,
    characters: row.characters,
    audioSeconds: row.audio_seconds,
    credits: row.credits,
    creditsUnit: row.credits_unit,
    estimatedCostUsd: row.estimated_cost_usd,
    actualCostUsd: row.actual_cost_usd,
    adjustmentUsd: Math.round(adjustmentUsd * 1e6) / 1e6,
    currency: "USD",
    rateSource: row.rate_source,
    rateVersion: row.rate_version,
    rateEffective: row.rate_effective,
    provenance: row.provenance as CostProvenance,
    chargeState: row.charge_state as ChargeState,
    metrics: parse<Record<string, number>>(row.metrics_json, {}),
    spans: parse<UsageSpan[]>(row.spans_json, []),
    httpRequests: row.http_requests,
    httpErrors: row.http_errors,
    httpMs: row.http_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
